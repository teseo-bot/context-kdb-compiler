import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { GcsStorageAdapter } from './infrastructure/storage-adapter';
import { CompilerEngine } from './core/compiler-engine';
import { DocumentDistiller } from './ingestion/distiller';
import { resolveDocumentContent } from './ingestion/resolve-document-content';
import { IngestRequestV1Schema } from './schemas/contracts'; // Import the new schema
import { z } from 'zod'; // For schema validation
import { BundleStore } from './infrastructure/bundle-store';
import { EmbeddingsClient, GeminiEmbeddingsClient } from './infrastructure/embeddings';
import { MockEmbeddingsClient } from './infrastructure/embeddings.mock';
import { indexDelta } from './indexing/indexer';
import { validateConcept } from './partners/validator';
import { createPartnerBundleWithStorage } from './partners/bundle';
import { ingestPartnerDocument, PartnerIngestInput } from './partners/partner-ingest';
import { uploadPartnerSource, PartnerSourceTooLargeError } from './partners/source-upload';
import { updatePartnerDraft, DraftUpdateInput } from './partners/partner-draft-update';
import { listPartnerDrafts, getPartnerDraft, PartnerDraftsListInput, PartnerDraftGetInput } from './partners/partner-drafts-list';
import {
  publishPartnerPackage,
  PartnerPublishInput,
  PartnerPublishChainBrokenError,
  PartnerDraftsNotFoundError,
  PartnerPublishValidationError,
  PartnerPublishPartialFailureError,
} from './partners/publisher';
import { runPartnerAssist, PartnerAssistInput, PartnerAssistInputError, PartnerAssistLlmError } from './partners/partner-assist';
import { PartnerLicenseSyncInputSchema, upsertLicense, deleteLicense } from './partners/license-sync';
import { getPartnerPackageEvalStatus } from './partners/partner-eval-status';

export const app = new Hono();
const gcsAdapter = new GcsStorageAdapter();
const distiller = new DocumentDistiller();

// K3-W2: pool y cliente de embeddings compartidos para la ruta /internal/index-delta.
// Mismo patrón que CompilerEngine (K0-W1): mock SOLO bajo NODE_ENV==='test'.
const indexerPool = new Pool({
  connectionString: process.env.COLD_TIER_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres',
});
const indexerEmbeddings: EmbeddingsClient =
  process.env.NODE_ENV === 'test' ? new MockEmbeddingsClient() : new GeminiEmbeddingsClient();

// Initialize CompilerEngine. In production, we'd pass environment variables here.
const engine = new CompilerEngine({ dbUrl: process.env.DATABASE_URL });

// Ensure DB is initialized before starting processing
let dbInitialized = false;
async function ensureDb() {
  if (!dbInitialized) {
    // E11-H3: DDL runtime should be handled by migrations, so no direct DDL here.
    // engine.initDb() should now only ensure connection or run checks, not schema creation.
    await engine.initDb(); 
    dbInitialized = true;
  }
}

// E11-H2: Middleware for Bearer token authentication on /v1/* endpoints
app.use('/v1/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const BEARER_TOKEN = process.env.TESEO_API_KEY; // Assuming an API key env var

  if (!BEARER_TOKEN) {
    console.error('TESEO_API_KEY is not set. M2M authentication cannot be performed.');
    return c.json({ error: 'Server configuration error: TESEO_API_KEY missing.' }, 500);
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid Authorization header.' }, 401);
  }

  const token = authHeader.substring(7); // "Bearer ".length

  if (token !== BEARER_TOKEN) { // Simple token comparison
    return c.json({ error: 'Unauthorized: Invalid token.' }, 401);
  }

  await next();
});

// E11-H1: New /v1/ingest endpoint
app.post('/v1/ingest', async (c) => {
  try {
    const rawBody = await c.req.json();
    const parsedRequest = IngestRequestV1Schema.parse(rawBody);

    const { tenant_id, documents, workflow_id, tags, cold_tier_eligible, hocflit_hint } = parsedRequest;

    // E11-H3: Store ingestion job details in a new 'ingest_jobs' table
    // This is a conceptual call; actual implementation would use a DB client
    const jobId = await engine.createIngestJob({
      tenant_id,
      status: 'pending',
      requested_at: new Date().toISOString(),
      documents_count: documents.length,
      workflow_id,
      tags,
      cold_tier_eligible,
      // Store raw documents or pointers to them for processing
      // In a real scenario, documents might be uploaded to GCS first and URIs stored here
      document_metadata: documents.map(doc => ({ document_id: doc.document_id, metadata: doc.metadata }))
    });

    // Asynchronously process documents (e.g., send to a Pub/Sub queue for background processing)
    // For this epic, we'll simulate immediate processing for now, but mark it for async
    console.log(`Ingestion job ${jobId} created for tenant ${tenant_id}. Starting document processing...`);

    // Simulate processing each document
    // K9-W1b (gap PDFs binarios): content_encoding='base64' + mime_type soportado por
    // DocumentDistiller se decodifica/extrae aquí. Un fallo de extracción/compile en UN
    // documento NO debe tumbar el batch completo: se colecta y se reporta por-documento.
    const documentErrors: Array<{ document_id: string; error: string }> = [];
    for (const doc of documents) {
      await ensureDb();
      try {
        // E11-H3: Propagate tenant_id to compiler/distiller if they directly handle it
        const markdownContent = await resolveDocumentContent(doc, distiller);
        await engine.compile(markdownContent, {
          title: doc.document_id,
          source: `ingest-api/${jobId}/${doc.document_id}`,
          tenantId: tenant_id, // Propagate tenant_id
          ...(doc.metadata ?? {}),
          // K9-W1 (SPEC-K9 §2.2): sesgo HOCFLIT de origen, persistido en documents.metadata.
          // Spread después de doc.metadata para que el hint del request gane si hubiera choque
          // de clave, sin romper el shape existente de metadata por documento.
          ...(hocflit_hint ? { hocflit_hint } : {}),
        });
        // In a real system, each document compilation might update the job status
      } catch (docError) {
        const message = docError instanceof Error ? docError.message : String(docError);
        console.error(`[v1/ingest] Documento ${doc.document_id} falló en job ${jobId}:`, message);
        documentErrors.push({ document_id: doc.document_id, error: message });
      }
    }

    // E11-H4: Update job status to complete (or 'processing' if truly async).
    // K9-W1b: si hubo errores por-documento, el job queda 'completed_with_errors' en vez de
    // 'completed' ciego; el batch avanza igual (no se aborta por un documento roto).
    const finalStatus = documentErrors.length > 0 ? 'completed_with_errors' : 'completed';
    await engine.updateIngestJobStatus(jobId, finalStatus);

    return c.json(
      {
        jobId,
        status: 'accepted',
        ...(documentErrors.length > 0 ? { document_errors: documentErrors } : {}),
      },
      202
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error for /v1/ingest:', error.issues);
      return c.json({ error: 'Validation Failed', details: error.issues }, 400);
    }
    console.error('Error in /v1/ingest:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// E11-H1: New /v1/jobs/:id endpoint
app.get('/v1/jobs/:id', async (c) => {
  try {
    const jobId = c.req.param('id');
    // E11-H3: Retrieve job status from 'ingest_jobs' table, filtering by tenant_id (conceptual)
    // In a real scenario, tenant_id would be passed via auth context or query params for RLS
    const jobStatus = await engine.getIngestJobStatus(jobId /*, tenant_id from auth context */);

    if (!jobStatus) {
      return c.json({ error: 'Job not found' }, 404);
    }

    return c.json(jobStatus, 200);
  } catch (error) {
    console.error('Error in /v1/jobs/:id:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.post('/pubsub', async (c) => {
  // F-H1: Validar OIDC JWT de Pub/Sub
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing Bearer token' }, 401);
  }
  // En producción, validar el JWT con las claves públicas de Google.
  // Por ahora, validar que el token exista y marcar TODO para validación completa.
  // Si no hay GOOGLE_PUBSUB_VERIFICATION_EMAIL configurado, aceptar cualquier Bearer (dev only).
  const pubsubVerifier = process.env.GOOGLE_PUBSUB_VERIFICATION_EMAIL;
  if (!pubsubVerifier) {
    console.warn('[F-H1] GOOGLE_PUBSUB_VERIFICATION_EMAIL no configurado. Validación OIDC saltada (dev only).');
  }
  // TODO: Implement full OIDC JWT validation here using Google's public keys.
  // For development, we proceed if a Bearer token exists and pubsubVerifier is not set.

  try {
    const body = await c.req.json();
    
    // Pub/Sub push messages are structured as:
    // { "message": { "data": "base64-encoded-string", "messageId": "..." } }
    if (!body.message || !body.message.data) {
      console.warn('Invalid Pub/Sub payload structure');
      return c.json({ error: 'Bad Request' }, 400);
    }

    const dataBuffer = Buffer.from(body.message.data, 'base64');
    const dataJson = JSON.parse(dataBuffer.toString('utf-8'));

    const bucket = dataJson.bucket;
    const name = dataJson.name;
    const tenantId = dataJson.tenant_id; // E11-H3: Extract tenant_id from Pub/Sub message

    if (!bucket || !name || !tenantId) { // E11-H3: tenantId is now mandatory for cold-tier
      console.warn('Missing bucket, name, or tenant_id in Pub/Sub data');
      return c.text('Missing bucket, name, or tenant_id', 400);
    }

    // Only process .md files
    if (!name.endsWith('.md')) {
      console.log(`Ignoring non-markdown file: ${name}`);
      return c.text('Ignored: not a markdown file', 200);
    }

    console.log(`Processing file: gs://${bucket}/${name} for tenant ${tenantId}`);

    // Download content
    const markdownContent = await gcsAdapter.readFromBucket(bucket, name);

    // Ensure DB is ready
    await ensureDb();

    // Compile and store
    const result = await engine.compile(markdownContent, {
      title: name,
      source: `gs://${bucket}/${name}`,
      bucket: bucket,
      fileName: name,
      tenantId: tenantId, // E11-H3: Propagate tenant_id to compiler
    });

    console.log(`Successfully compiled gs://${bucket}/${name} for tenant ${tenantId}. Chunks: ${result.chunkCount}`);
    
    return c.text('Success', 200);

  } catch (error) {
    console.error('Error processing Pub/Sub message:', error);
    // Return 500 to trigger a retry in Pub/Sub
    return c.text('Internal Server Error', 500);
  }
});

// K3-W2 (BACKEND §A8, PLAN K3-W2): ruta M2M interna para disparar el índice delta de un
// tenant (invocada por night-worker/phases/index-regen.ts vía HTTP interno, BACKEND §C2).
// Auth: header `x-api-key` === process.env.M2M_API_KEY (no existía aún un patrón M2M por
// x-api-key en este server.ts; las rutas /v1/* usan Authorization: Bearer con TESEO_API_KEY.
// Se sigue literalmente lo pedido por la WU: header y variable de entorno distintos, dedicados
// a llamadas servicio-a-servicio internas del Cerebro Virtual).
app.post('/internal/index-delta', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/index-delta cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const { tenantId } = z.object({ tenantId: z.string().min(1) }).parse(rawBody);

    const store = new BundleStore({ tenantId });
    const result = await indexDelta(tenantId, {
      pool: indexerPool,
      store,
      embeddings: indexerEmbeddings,
    });

    return c.json(result, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/index-delta:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// KL0-W3 (PLAN-KnowledgeLab-Epicas-KL.md; DISEÑO-Knowledge-Lab.md §3.3): ruta M2M de
// validación OKF de 3 niveles para el Knowledge Lab de aliados. PURA: solo lee (a lo sumo un
// SELECT sobre okf_partner_concepts para resolver packagePaths); cero escrituras a bundle,
// índice o BD ([INV-KL5]). Mismo patrón de auth `x-api-key === M2M_API_KEY` que
// /internal/index-delta. La misma librería (src/partners/validator.ts) validará en el editor
// (vía panel) y en el gate del publisher cuando exista ([INV-KL1]).
app.post('/internal/partner-validate', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-validate cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const body = z.object({
      markdown: z.string().min(1),
      partner_id: z.string().uuid(),
      package_slug: z.string().optional(),
      for_publish: z.boolean().optional(),
      package_paths: z.array(z.string()).optional(),
    }).parse(rawBody);

    let packagePaths = body.package_paths;

    if (!packagePaths && body.package_slug) {
      // KL0-W3 — CONTRADICCIÓN DETECTADA CON EL CÓDIGO REAL (reportada, no improvisada):
      // migrations/007_partner_index.sql define okf_partner_concepts con columna `package_id`
      // (UUID), SIN columna `package_slug`. No existe en este repo (ni en ningún otro accesible
      // desde el Cold-Tier del compiler) una tabla que resuelva partner_id + package_slug →
      // package_id; ese mapeo, de existir, vive en el plano de control `teseo-control`
      // (multitenant-admin-panel, otra base de datos por completo — ADR-206), al que este
      // servicio no está conectado. Para no inventar un join inexistente: `package_slug` solo
      // se acepta aquí si es literalmente un UUID (se interpreta como `package_id`); si no lo
      // es, se responde 501 explícito en vez de adivinar. Ver el reporte de la WU KL0-W3 para
      // decidir el mapeo real (candidato: exponer package_id además de/en vez de package_slug
      // desde el panel, que sí conoce el plano de control).
      const packageIdCandidate = z.string().uuid().safeParse(body.package_slug);
      if (!packageIdCandidate.success) {
        return c.json({
          error: 'Not Implemented',
          details:
            'package_slug no resuelve a package_id: okf_partner_concepts (migrations/007) no tiene columna package_slug y no hay mapeo slug→id accesible desde este servicio. Pasa package_paths explícitamente, o un package_slug que sea el UUID de package_id.',
        }, 501);
      }

      const { rows } = await indexerPool.query(
        'SELECT DISTINCT path FROM okf_partner_concepts WHERE partner_id = $1 AND package_id = $2',
        [body.partner_id, packageIdCandidate.data]
      );
      packagePaths = rows.map((r: { path: string }) => r.path);
    }

    const report = validateConcept(body.markdown, {
      level: 'n3',
      packagePaths,
      forPublish: body.for_publish,
    });

    return c.json(report, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-validate:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// PA2-W1: ruta M2M interna para crear bundle de aliado
// Auth: header `x-api-key` === process.env.M2M_API_KEY
// Body: {partner_id}
app.post('/internal/partner-bundle-create', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-bundle-create cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const { partner_id } = z.object({ partner_id: z.string().uuid() }).parse(rawBody);

    const result = await createPartnerBundleWithStorage(partner_id);

    return c.json({
      partner_id,
      bucket_name: `${process.env.GCS_PARTNER_BUNDLE_PREFIX ?? 'kdb-partner-'}${partner_id}`,
      files_created: result.fileCount,
      verified: result.verified,
    }, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-bundle-create:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// PA2-W3: ruta M2M interna para ingerir documento de aliado
// Auth: header `x-api-key` === process.env.M2M_API_KEY
// Body: {partner_id, package_slug, document: {filename, content_base64 | text}}
//    o: {partner_id, package_slug, source_gcs_object} (KL2-W2 — lee el documento ya subido a
//       `_fuentes/` vía /internal/partner-source-upload en vez de requerir que el panel
//       reenvíe el binario completo; ver src/partners/partner-ingest.ts::resolveDocument)
// Pipeline: distiller-v2 → router HOCFLIT → pii-redactor → draft a _staging/
app.post('/internal/partner-ingest', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-ingest cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const input = z.object({
      partner_id: z.string().uuid(),
      package_slug: z.string().min(1),
      document: z.object({
        filename: z.string().min(1),
        content_base64: z.string().optional(),
        text: z.string().optional(),
      }).optional(),
      source_gcs_object: z.string().min(1).optional(),
    }).refine((v) => v.document || v.source_gcs_object, {
      message: 'Debe traer document o source_gcs_object',
    }).parse(rawBody);

    const store = new BundleStore({
      tenantId: input.partner_id,
    });

    const result = await ingestPartnerDocument(input as PartnerIngestInput, store);

    return c.json(result, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-ingest:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// KL2-W1 (PLAN-KnowledgeLab-Epicas-KL.md; DISEÑO-Knowledge-Lab.md §3.2/§3.3): ruta M2M interna
// para subir una fuente cruda del aliado a `_fuentes/` del bundle. Espeja la mecánica raw que
// usa el génesis del bundle (partners/bundle.ts::writePartnerBundle) para escribir
// `_staging/.keep`: escribe vía BundleStore.write() en un path que NO termina en `.md`, por lo
// que la validación de frontmatter no se dispara; la entrada SÍ queda en el hash-chain de
// log.md (misma vía única de escritura). Ver src/partners/source-upload.ts para el detalle de
// codificación (el contenido se guarda como el base64 recibido, no como bytes binarios).
// Auth: header `x-api-key` === process.env.M2M_API_KEY (mismo patrón que /internal/*).
// Body: {partner_id, filename, content_base64}
app.post('/internal/partner-source-upload', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-source-upload cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const input = z.object({
      partner_id: z.string().uuid(),
      filename: z.string().min(1),
      content_base64: z.string().min(1),
    }).parse(rawBody);

    const store = new BundleStore({
      tenantId: input.partner_id,
    });

    const result = await uploadPartnerSource(
      { partner_id: input.partner_id, filename: input.filename, content_base64: input.content_base64 },
      store
    );

    return c.json({ sha256: result.sha256, gcs_object: result.gcs_object }, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    if (error instanceof PartnerSourceTooLargeError) {
      return c.json({ error: error.message }, 413);
    }
    console.error('Error in /internal/partner-source-upload:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// PA2-W3: ruta M2M interna para actualizar draft de aliado (curaduría)
// Auth: header `x-api-key` === process.env.M2M_API_KEY
// Body: {partner_id, draft_path, markdown}
// Validaciones:
//  - draft_path debe estar bajo _staging/ (422 si no)
//  - frontmatter válido contra PartnerConceptFrontmatterSchema excepto confidence
//  - curator completo (422 si no)
//  - confidence forzado a 'draft'
app.post('/internal/partner-draft-update', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-draft-update cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const input = z.object({
      partner_id: z.string().uuid(),
      draft_path: z.string().min(1),
      markdown: z.string().min(1),
    }).parse(rawBody);

    const store = new BundleStore({
      tenantId: input.partner_id,
    });

    const result = await updatePartnerDraft(input as DraftUpdateInput, store);

    return c.json(result, 200);
  } catch (error: any) {
    // Errores de validación del tipo {code: 422, message: string}
    if (error?.code === 422) {
      return c.json({ error: error.message }, 422);
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-draft-update:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// KL3-W1 (PLAN-KnowledgeLab-Epicas-KL.md; DISEÑO-Knowledge-Lab.md §4 P-KL3): ruta M2M interna
// de listado de drafts de aliado para el editor guiado. Auth: header `x-api-key` ===
// process.env.M2M_API_KEY (mismo patrón que el resto de /internal/*). Body:
// {partner_id, package_slug?}. PURA: solo lee GCS (BundleStore.list/read) y, a lo sumo, un
// SELECT sobre okf_partner_concepts para el filtro de publicados — cero escrituras.
// Ver src/partners/partner-drafts-list.ts (cabecera) para el criterio exacto de exclusión de
// drafts ya publicados (resolución as-built PA2-W4: _staging/ es append-only).
app.post('/internal/partner-drafts-list', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-drafts-list cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const input = z.object({
      partner_id: z.string().uuid(),
      package_slug: z.string().min(1).optional(),
    }).parse(rawBody);

    const store = new BundleStore({ tenantId: input.partner_id });
    const result = await listPartnerDrafts(input as PartnerDraftsListInput, store, indexerPool);

    return c.json(result, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-drafts-list:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// KL3-W1: ruta M2M interna de lectura de un draft de aliado (markdown crudo para el editor).
// Auth: header `x-api-key` === process.env.M2M_API_KEY. Body: {partner_id, draft_path}.
// Reúsa el guard anti-traversal de /internal/partner-draft-update (validateDraftPath): 422 si
// draft_path no está bajo _staging/. Cero escrituras.
app.post('/internal/partner-draft-get', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-draft-get cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const input = z.object({
      partner_id: z.string().uuid(),
      draft_path: z.string().min(1),
    }).parse(rawBody);

    const store = new BundleStore({ tenantId: input.partner_id });
    const result = await getPartnerDraft(input as PartnerDraftGetInput, store);

    return c.json(result, 200);
  } catch (error: any) {
    if (error?.code === 422) {
      return c.json({ error: error.message }, 422);
    }
    if (error?.code === 404) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-draft-get:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// KL3-W2 (PLAN-KnowledgeLab-Epicas-KL.md; DISEÑO-Knowledge-Lab.md §3.3): asistente IA del
// Knowledge Lab de aliados — 3 modos (draft_from_source/reorganize/fix_findings). Auth: header
// `x-api-key` === process.env.M2M_API_KEY (mismo patrón que el resto de /internal/*).
// Guardrails obligatorios ([INV-KL3]/[INV-KL4]/[INV-KL6], RP-KL4/RP-KL8): ver cabecera de
// src/partners/partner-assist.ts. Cero escrituras — la salida SIEMPRE se revalida
// (validateConcept level 'n3') y se devuelve {markdown, report, stripped_refs}, nunca persiste.
const PartnerAssistFindingSchema = z.object({
  rule_id: z.string(),
  level: z.enum(['n1', 'n2', 'n3']).optional(),
  severity: z.enum(['error', 'warn']).optional(),
  message_es: z.string(),
  line: z.number().optional(),
  fix: z.object({
    kind: z.enum(['set_field', 'replace_text']),
    description_es: z.string(),
    value: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }).optional(),
});

app.post('/internal/partner-assist', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-assist cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const input = z.object({
      mode: z.enum(['draft_from_source', 'reorganize', 'fix_findings']),
      partner_id: z.string().uuid(),
      markdown: z.string().min(1).optional(),
      source_gcs_objects: z.array(z.string().min(1)).optional(),
      findings: z.array(PartnerAssistFindingSchema).optional(),
      concept_type: z.string().optional(),
      system: z.string().optional(),
    }).parse(rawBody);

    const store = new BundleStore({ tenantId: input.partner_id });
    const result = await runPartnerAssist(input as PartnerAssistInput, store);

    return c.json(result, 200);
  } catch (error) {
    if (error instanceof PartnerAssistInputError) {
      return c.json({ error: error.message }, 422);
    }
    if (error instanceof PartnerAssistLlmError) {
      return c.json({ error: error.message }, 502);
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-assist:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// PA2-W4: ruta M2M interna para publicar una versión firmada de paquete de aliado.
// Auth: header `x-api-key` === process.env.M2M_API_KEY (mismo patrón que /internal/index-delta).
// Body: {partner_id, partner_slug, package_id, package_slug, version, draft_paths[]} — la
// identidad (partner/paquete) y la selección de drafts aprobados las decide el panel
// (teseo-control); este compiler NO adivina ninguna de las dos (resolución de asignación,
// PLAN-Aliados-Epicas-PA.md PA2-W4).
// Secuencia: (1) verifyChain() → 409 si rota [INV-3.3]; (2) lee y valida TODOS los drafts
// (404 si falta alguno; 422 + reports si ∃ error de validación, CERO cambios [INV-3.1]);
// (3) escribe conceptos + portada del paquete; (4) manifest canónico + firma KMS; (5) índice
// delta a okf_partner_concepts/okf_partner_edges en una transacción [INV-6.1]. Fallo en los
// pasos 3-5 → 500 con detalle de qué quedó escrito (sin rollback de GCS, ver src/partners/publisher.ts).
app.post('/internal/partner-publish', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-publish cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const input = z.object({
      partner_id: z.string().uuid(),
      partner_slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/),
      package_id: z.string().uuid(),
      package_slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,59}$/),
      version: z.number().int().min(1),
      draft_paths: z.array(z.string().min(1)).min(1),
    }).parse(rawBody);

    const result = await publishPartnerPackage(input as PartnerPublishInput, {
      pool: indexerPool,
      embeddings: indexerEmbeddings,
    });

    return c.json(result, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    if (error instanceof PartnerPublishChainBrokenError) {
      return c.json({ error: error.message }, 409);
    }
    if (error instanceof PartnerDraftsNotFoundError) {
      return c.json({ error: error.message, missing: error.missing }, 404);
    }
    if (error instanceof PartnerPublishValidationError) {
      return c.json({ error: error.message, reports: error.reports }, 422);
    }
    if (error instanceof PartnerPublishPartialFailureError) {
      return c.json({ error: error.message, partial: error.partial }, 500);
    }
    console.error('Error in /internal/partner-publish:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// PA4-W3a: ruta M2M de sync de licencias — el panel (teseo-control) proyecta un contrato de
// aliado a una fila de kdb_partner_licenses y llama aquí para reflejarla. Auth: header
// `x-api-key` === process.env.M2M_API_KEY (mismo patrón que el resto de /internal/*).
// action='upsert' → upsertLicense (INSERT ... ON CONFLICT (contract_id) DO UPDATE);
// action='delete' → deleteLicense (DELETE por contract_id).
app.post('/internal/partner-license-sync', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-license-sync cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const rawBody = await c.req.json();
    const input = PartnerLicenseSyncInputSchema.parse(rawBody);

    if (input.action === 'upsert') {
      const license = input.license!;
      await upsertLicense(indexerPool, {
        contract_id: input.contract_id,
        tenant_id: license.tenant_id,
        partner_id: license.partner_id,
        package_id: license.package_id,
        version: license.version,
        systems: license.systems,
        altitude_max: license.altitude_max,
        modules: license.modules,
        valid_from: license.valid_from,
        valid_until: license.valid_until,
        status: license.status,
        partner_slug: license.partner_slug,
        partner_legal_name: license.partner_legal_name,
        package_slug: license.package_slug,
        package_title: license.package_title,
      });
    } else {
      await deleteLicense(indexerPool, input.contract_id);
    }

    return c.json({ ok: true, action: input.action }, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-license-sync:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// PA7-W2: ruta M2M interna de estado del gate de eval de paquete — el panel (teseo-control) la
// llama antes de activar el PRIMER contrato de un paquete de aliado, NUNCA consulta el Cold-Tier
// directo. Auth: header `x-api-key` === process.env.M2M_API_KEY (mismo patrón que
// /internal/partner-license-sync). Query params: package_id, partner_id (ambos UUID).
app.get('/internal/partner-package-eval-status', async (c) => {
  const M2M_API_KEY = process.env.M2M_API_KEY;
  if (!M2M_API_KEY) {
    console.error('M2M_API_KEY is not set. /internal/partner-package-eval-status cannot authenticate requests.');
    return c.json({ error: 'Server configuration error: M2M_API_KEY missing.' }, 500);
  }

  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader !== M2M_API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
  }

  try {
    const query = z
      .object({
        package_id: z.string().uuid(),
        partner_id: z.string().uuid(),
      })
      .parse({
        package_id: c.req.query('package_id'),
        partner_id: c.req.query('partner_id'),
      });

    const status = await getPartnerPackageEvalStatus(indexerPool, query.package_id, query.partner_id);
    return c.json(status, 200);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation Failed', details: error.issues }, 422);
    }
    console.error('Error in /internal/partner-package-eval-status:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// K0-W1 (F-H3): validación de credencial de embeddings al arranque.
// Ya no existe fallback a mock en runtime: sin credencial, compile() falla en la primera llamada.
const GEMINI_KEY = process.env.GEMINI_DIRECT_KEY || process.env.GEMINI_API_KEYS?.split(',')[0];
if (!GEMINI_KEY) {
  console.error('CRITICAL: GEMINI_DIRECT_KEY not set. Embeddings will fail at compile time (no mock fallback).');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

// DEPRECATED: Migrar a /v1/ingest
app.post('/ingest/telegram', async (c) => {
  const authHeader = c.req.header('Authorization');
  const BEARER_TOKEN = process.env.TESEO_API_KEY; // Assuming an API key env var

  if (!BEARER_TOKEN) {
    console.error('TESEO_API_KEY is not set. M2M authentication cannot be performed.');
    return c.json({ error: 'Server configuration error: TESEO_API_KEY missing.' }, 500);
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid Authorization header.' }, 401);
  }

  const token = authHeader.substring(7); // "Bearer ".length

  if (token !== BEARER_TOKEN) { // Simple token comparison
    return c.json({ error: 'Unauthorized: Invalid token.' }, 401);
  }

  try {
    const body = await c.req.parseBody();
    const file = body['file'];
    const tenantId = body['tenant_id'] as string; // E11-H3: Expect tenant_id from form data

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file provided in form data under "file" field' }, 400);
    }
    
    if (!tenantId) { // E11-H3: tenant_id is now mandatory
      return c.json({ error: 'Missing tenant_id in form data' }, 400);
    }

    if (file.size > 10 * 1024 * 1024) {
      return c.json({ error: 'Payload Too Large' }, 413);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Call DocumentDistiller
    const markdown = await distiller.processBuffer(buffer, file.type, file.name);

    // Upload to GCS (mockable via adapter)
    const bucketName = process.env.GCS_BUCKET || 'telegram-ingestion-bucket';
    const timestamp = Date.now();
    const cleanName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const mdFileName = `ingested/${tenantId}/${timestamp}-${cleanName}.md`; // E11-H3: Use tenantId in GCS path

    const gcsUri = await gcsAdapter.upload(bucketName, mdFileName, markdown, 'text/markdown');

    // E11-H3: In a real scenario, this would trigger the compiler with tenantId context
    // For now, we return success and assume a Pub/Sub trigger or similar will handle compilation
    // with the tenantId passed along.

    return c.json({ success: true, uri: gcsUri, tenantId: tenantId });
  } catch (error) {
    console.error('Error in /ingest/telegram:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

const port = parseInt(process.env.PORT || '8080', 10);

// KL0-W3: guard NODE_ENV==='test' (mismo patrón que embeddings/CompilerEngine en este mismo
// archivo) — permite importar `app` en tests (ej. server.test.ts) sin levantar un listener TCP
// real, que antes era un efecto secundario incondicional al importar este módulo.
if (process.env.NODE_ENV !== 'test') {
  console.log(`Starting server on port ${port}...`);
  serve({
    fetch: app.fetch,
    port
  });
}

// --- E11-H3/H4: Conceptual Database/Engine Changes for tenant_id and ingest_jobs ---
// The following additions are conceptual and represent what would be needed in CompilerEngine
// and its dependencies (like database adapter) to support tenant_id and ingest_jobs.

declare module "./core/compiler-engine" {
  interface CompilerEngine {
    initDb(): Promise<void>;
    compile(markdown: string, options: { title: string; source: string; bucket?: string; fileName?: string; tenantId?: string; }): Promise<{ chunkCount: number }>;
    createIngestJob(jobDetails: {
      tenant_id: string;
      status: string;
      requested_at: string;
      documents_count: number;
      workflow_id?: string;
      tags?: string[];
      cold_tier_eligible?: boolean;
      document_metadata: Array<{ document_id: string; metadata?: Record<string, any> }>;
    }): Promise<string>;
    updateIngestJobStatus(jobId: string, status: string): Promise<void>;
    getIngestJobStatus(jobId: string): Promise<any | null>;
  }
}

// In a real implementation:
// - CompilerEngine would be updated to accept tenant_id in its compile method and pass it to DB operations.
// - The DB adapter would ensure all document and chunk insertions include tenant_id.
// - A new 'ingest_jobs' table would be created (via migration, not DDL here) to store job state.
// - All queries against 'documents' and 'chunks' tables would filter by 'tenant_id'.
// - The 'initDb' method would be simplified to only connect/verify, not create schemas.
// - The DocumentDistiller might also be updated to accept tenant_id for any internal logging/metadata.

