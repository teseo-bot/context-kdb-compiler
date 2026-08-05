// K4-W2 (BACKEND §A3, WORKFLOWS §2): entrada de V2 — poller de knowledge_candidates.
// Corre como job (`npm run v2 -- --tenant={id}` y por Cloud Scheduler en prod).
//
// Loop por lote (BACKEND §A3):
//   SELECT ... WHERE status='pending' AND tenant_id=$1 ORDER BY created_at LIMIT 20
//   FOR UPDATE SKIP LOCKED (en transacción) -> marcar 'processing' -> por candidate:
//     1. anti-duplicado (BACKEND §A7): okf_provenance.source_ref O knowledge_candidates con
//        status='drafted' y mismo source_ref -> si duplicado: 'discarded'.
//     2. resolver contenido crudo (opts.resolveRawContent, default abajo).
//     3. distillCandidate (K4-W1).
//     4. buildTargetPath + resolveCollision (K4-W1), consultando títulos existentes del mismo
//        sistema en okf_concepts.
//     5. redactPii sobre title/description/body (K4-W1).
//     6. componer DraftConcept completo, validar con DraftConceptSchema.
//     7. writeDraftToStaging (K4-W2) -> marcar 'drafted'.
//   Errores por candidate: marcar 'error' con mensaje, continuar con el siguiente (nunca
//   abortar el lote por un candidate). Repetir lotes hasta que no haya pending.
//
// Invariantes WORKFLOWS §2: (1) nada sale de _staging en V2; (2) todo draft tiene
// confidence:'draft' y pii != 'raw'; (3) re-ejecutar el job no duplica drafts.

import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { BundleStore } from '../infrastructure/bundle-store';
import { DraftConceptSchema, DraftConcept } from '../infrastructure/concept-frontmatter.schema';
import { HocflitHint, HocflitHintSchema } from '../schemas/contracts';
import { discoverCandidates, DiscoverCandidatesResult } from './candidate-discovery';
import { distillCandidate, DistillerLlm, DistillCandidateInput } from './distiller-v2';
import { buildTargetPath, resolveCollision } from './hocflit-router';
import { redactPii, PiiLlm } from './pii-redactor';
import { writeDraftToStaging } from './staging-writer';

const BATCH_SIZE = 20;

interface CandidateRow {
  id: string;
  tenant_id: string;
  kind: string;
  source_ref: string;
  payload_summary: string;
  status: string;
  created_at: string;
  metadata?: unknown;
}

/**
 * K9-W1 (SPEC-K9 §2.4): extrae el hint HOCFLIT de origen de knowledge_candidates.metadata
 * (copiado ahí por candidate-discovery, K9-W1 §2.3), si existe y es válido. Nunca lanza: un
 * hint malformado se ignora silenciosamente (el candidate se procesa igual que sin hint).
 */
function extractHint(candidate: CandidateRow): HocflitHint | undefined {
  const metadata = (candidate.metadata ?? {}) as Record<string, unknown>;
  const raw = metadata.hocflit_hint;
  if (raw === undefined || raw === null) return undefined;

  const parsed = HocflitHintSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export interface RunV2Options {
  tenantId: string;
  pool: Pool;
  store: BundleStore;
  distillerLlm?: DistillerLlm;
  piiLlm?: PiiLlm;
  resolveRawContent?: (candidate: CandidateRow) => Promise<string>;
}

export interface RunV2Result {
  drafted: number;
  discarded: number;
  errors: number;
  discovered: DiscoverCandidatesResult;
}

/**
 * Resolución por defecto del contenido crudo de un candidate:
 * - doc:sha256:{hash} -> SELECT content FROM documents WHERE document_hash=$1 (mismo tenant).
 * - conv:/otros -> usar payload_summary. TODO K4-W3: resolver mensajes completos del thread
 *   desde el Single-Tenant DB (Hot-Tier) una vez que el orquestador exponga esa vía; por ahora
 *   payload_summary (últimos 500 chars de la conversación, ver BACKEND §B1) es la única fuente
 *   disponible desde el Cold-Tier.
 */
async function defaultResolveRawContent(
  client: PoolClient,
  tenantId: string,
  candidate: CandidateRow
): Promise<string> {
  const docMatch = candidate.source_ref.match(/^doc:sha256:([a-f0-9]{64})$/);
  if (docMatch) {
    const hash = docMatch[1];
    const res = await client.query<{ content: string }>(
      'SELECT content FROM documents WHERE document_hash = $1 AND tenant_id = $2',
      [hash, tenantId]
    );
    if (res.rows.length > 0) {
      return res.rows[0].content;
    }
    // Si no se encuentra el documento (caso límite), caer a payload_summary igual que conv:/otros.
    return candidate.payload_summary;
  }

  // conv:/db:/url: y cualquier otro kind -> payload_summary (TODO K4-W3 arriba).
  return candidate.payload_summary;
}

/**
 * Chequeo anti-duplicado (BACKEND §A7): la fuente ya alimentó un concepto consolidado
 * (okf_provenance.source_ref) o ya fue destilada y está pendiente de consolidar
 * (knowledge_candidates con status='drafted' y mismo source_ref, EXCLUYENDO el propio candidate).
 */
async function isDuplicateSource(
  client: PoolClient,
  tenantId: string,
  candidateId: string,
  sourceRef: string
): Promise<boolean> {
  const provenance = await client.query(
    'SELECT 1 FROM okf_provenance WHERE source_ref = $1 AND tenant_id = $2 LIMIT 1',
    [sourceRef, tenantId]
  );
  if (provenance.rows.length > 0) return true;

  const draftedCandidate = await client.query(
    `SELECT 1 FROM knowledge_candidates
     WHERE source_ref = $1 AND tenant_id = $2 AND status = 'drafted' AND id != $3
     LIMIT 1`,
    [sourceRef, tenantId, candidateId]
  );
  return draftedCandidate.rows.length > 0;
}

/**
 * Títulos existentes en el mismo sistema (okf_concepts.frontmatter->>'title'), para
 * resolveCollision (K4-W1).
 */
async function fetchExistingTitles(
  client: PoolClient,
  tenantId: string,
  systemSlug: string
): Promise<string[]> {
  const res = await client.query<{ title: string }>(
    `SELECT frontmatter->>'title' AS title FROM okf_concepts
     WHERE tenant_id = $1 AND system_slug = $2`,
    [tenantId, systemSlug]
  );
  return res.rows.map((r) => r.title).filter((t): t is string => typeof t === 'string');
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Procesa un único candidate ya marcado 'processing'. Devuelve el status final
 * ('drafted' | 'discarded') o lanza si hay un error (el caller lo captura y marca 'error').
 */
async function processCandidate(
  client: PoolClient,
  opts: RunV2Options,
  candidate: CandidateRow
): Promise<'drafted' | 'discarded'> {
  const duplicate = await isDuplicateSource(client, opts.tenantId, candidate.id, candidate.source_ref);
  if (duplicate) {
    return 'discarded';
  }

  const resolveRaw = opts.resolveRawContent
    ? opts.resolveRawContent
    : (c: CandidateRow) => defaultResolveRawContent(client, opts.tenantId, c);
  const rawContent = await resolveRaw(candidate);

  const distillInput: DistillCandidateInput = {
    kind: candidate.kind,
    source_ref: candidate.source_ref,
    payload_summary: candidate.payload_summary,
  };
  const hint = extractHint(candidate);
  const distilled = await distillCandidate(distillInput, rawContent, opts.distillerLlm, hint);

  // NOTA: se pasa `{ tags: [...] }` como literal (en vez de `distilled.frontmatter` directo)
  // porque el tipo inferido por Zod para ConceptFrontmatterSchema (con `.refine()` sobre
  // `tags`) no es estructuralmente asignable a `{ tags: string[] }` en esta versión de
  // TypeScript/Zod (falso positivo de tsc, confirmado en aislamiento) — no se toca
  // hocflit-router.ts/concept-frontmatter.schema.ts (módulos de K4-W1, fuera de alcance).
  const targetPathRaw = buildTargetPath({ tags: distilled.frontmatter.tags }, distilled.frontmatter.title);
  const systemSlug = distilled.frontmatter.tags[0];
  const existingTitles = await fetchExistingTitles(client, opts.tenantId, systemSlug);
  const targetPath = await resolveCollision(targetPathRaw, existingTitles, distilled.frontmatter.title);

  const redacted = await redactPii(
    {
      title: distilled.frontmatter.title,
      description: distilled.frontmatter.description,
      body: distilled.body,
    },
    opts.piiLlm
  );

  const draft: DraftConcept = DraftConceptSchema.parse({
    draft_id: randomUUID(),
    tenant_id: opts.tenantId,
    frontmatter: {
      ...distilled.frontmatter,
      title: redacted.title,
      description: redacted.description,
      pii: redacted.pii,
    },
    body: redacted.body,
    target_path: targetPath,
  });

  await writeDraftToStaging(opts.store, draft, todayIsoDate());

  return 'drafted';
}

/**
 * Selecciona hasta BATCH_SIZE candidates 'pending' del tenant con FOR UPDATE SKIP LOCKED,
 * los marca 'processing' dentro de la misma transacción, y devuelve las filas bloqueadas.
 */
async function claimBatch(client: PoolClient, tenantId: string): Promise<CandidateRow[]> {
  await client.query('BEGIN');
  try {
    const selected = await client.query<CandidateRow>(
      `SELECT id, tenant_id, kind, source_ref, payload_summary, status, created_at, metadata
       FROM knowledge_candidates
       WHERE status = 'pending' AND tenant_id = $1
       ORDER BY created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [tenantId, BATCH_SIZE]
    );

    if (selected.rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const ids = selected.rows.map((r) => r.id);
    await client.query(
      `UPDATE knowledge_candidates SET status = 'processing' WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    await client.query('COMMIT');
    return selected.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function markStatus(
  client: PoolClient,
  candidateId: string,
  status: 'drafted' | 'discarded' | 'error',
  errorMessage?: string
): Promise<void> {
  await client.query(
    `UPDATE knowledge_candidates
     SET status = $1, error = $2, processed_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [status, errorMessage ?? null, candidateId]
  );
}

/**
 * runV2: procesa todos los candidates 'pending' del tenant en lotes de BATCH_SIZE hasta
 * agotarlos. Cada conexión del pool ejecuta SET app.tenant_id (RLS FORCE requiere esto para
 * ver/tocar filas del tenant) y RESET app.tenant_id al devolver la conexión.
 */
export async function runV2(opts: RunV2Options): Promise<RunV2Result> {
  // Paso 0 (K4-W4 v2): descubrimiento pull. Ya NO es condicional. Lo era por `opts.supabase`,
  // una llave que sólo abría la fuente de conversaciones de Supabase —sistema retirado por
  // ADR-206— y que de paso mantenía inalcanzable la fuente viva, los documentos sin candidate.
  // Ver la cabecera de candidate-discovery.ts. Es idempotente: los documentos que ya tienen
  // candidate no se re-descubren, así que correrlo en cada corrida es seguro.
  const discovered = await discoverCandidates({ tenantId: opts.tenantId, coldPool: opts.pool });

  const result: RunV2Result = { drafted: 0, discarded: 0, errors: 0, discovered };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const client = await opts.pool.connect();
    let batch: CandidateRow[];
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', opts.tenantId]);
      batch = await claimBatch(client, opts.tenantId);

      if (batch.length === 0) {
        break;
      }

      for (const candidate of batch) {
        try {
          const status = await processCandidate(client, opts, candidate);
          await markStatus(client, candidate.id, status);
          if (status === 'drafted') result.drafted++;
          else result.discarded++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            await markStatus(client, candidate.id, 'error', message);
          } catch {
            // Si ni siquiera se puede marcar el error, se sigue con el siguiente candidate
            // sin abortar el lote.
          }
          result.errors++;
        }
      }
    } finally {
      await client.query('RESET app.tenant_id');
      client.release();
    }
  }

  return result;
}

// ---------- CLI ----------

if (require.main === module) {
  (async () => {
    const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
    const tenantId = tenantArg?.split('=')[1];

    if (!tenantId) {
      console.error('Uso: tsx src/ingestion/candidate-poller.ts --tenant=<id>');
      process.exit(1);
    }

    const pool = new Pool({
      connectionString: process.env.COLD_TIER_URL || 'postgres://postgres:postgres@localhost:5436/postgres',
    });
    const store = new BundleStore({ tenantId });

    try {
      const summary = await runV2({ tenantId, pool, store });
      console.log(
        `[candidate-poller] tenant=${tenantId} drafted=${summary.drafted} discarded=${summary.discarded} errors=${summary.errors}`
      );
    } catch (error) {
      console.error('[candidate-poller] fallo la corrida:', error);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
