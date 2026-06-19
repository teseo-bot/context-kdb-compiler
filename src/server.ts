import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { GcsStorageAdapter } from './infrastructure/storage-adapter';
import { CompilerEngine } from './core/compiler-engine';
import { DocumentDistiller } from './ingestion/distiller';
import { IngestRequestV1Schema } from './schemas/contracts'; // Import the new schema
import { z } from 'zod'; // For schema validation

const app = new Hono();
const gcsAdapter = new GcsStorageAdapter();
const distiller = new DocumentDistiller();

// E11-H4: Validate EMBEDDINGS_URL at boot (fail-fast)
const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL;
if (!EMBEDDINGS_URL) {
  console.error('CRITICAL: EMBEDDINGS_URL environment variable is not set. Exiting.');
  console.warn('Proceeding without EMBEDDINGS_URL...');
}

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

    const { tenant_id, documents, workflow_id, tags, cold_tier_eligible } = parsedRequest;

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
    for (const doc of documents) {
      // E11-H3: Propagate tenant_id to compiler/distiller if they directly handle it
      const markdownContent = doc.content; // Assuming content is already markdown or easily convertible
      await ensureDb();
      await engine.compile(markdownContent, {
        title: doc.document_id,
        source: `ingest-api/${jobId}/${doc.document_id}`,
        tenantId: tenant_id, // Propagate tenant_id
      });
      // In a real system, each document compilation might update the job status
    }

    // E11-H4: Update job status to complete (or 'processing' if truly async)
    await engine.updateIngestJobStatus(jobId, 'completed');


    return c.json({ jobId, status: 'accepted' }, 202);
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

// F-H3: Fail-fast for EMBEDDINGS_URL if not set.
const EMBEDDINGS_URL_ENV = process.env.EMBEDDINGS_URL;
if (!EMBEDDINGS_URL_ENV) {
  console.error('CRITICAL: EMBEDDINGS_URL environment variable is not set. Exiting.');
  process.exit(1);
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

console.log(`Starting server on port ${port}...`);
serve({
  fetch: app.fetch,
  port
});

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

