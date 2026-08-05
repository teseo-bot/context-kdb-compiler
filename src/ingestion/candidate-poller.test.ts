// K4-W2: test de integración de candidate-poller contra el Postgres local
// (postgres://postgres:postgres@localhost:5436/postgres, migraciones 001-004 aplicadas) +
// BundleStore con storage en memoria (mismo patrón que bundle-store.test.ts).
//
// Sembrado como usuario 'postgres' (owner de las tablas, bypassa RLS) para no depender de
// SET app.tenant_id al insertar filas de prueba; el propio runV2 SÍ ejecuta
// SET app.tenant_id en cada conexión que toma del pool (ver candidate-poller.ts), que es lo
// que se está verificando funcionalmente.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { BundleStore, BundleStorageBackend, ReadResult, StoredObjectMeta } from '../infrastructure/bundle-store';
import { DistillerLlm } from './distiller-v2';
import { PiiLlm } from './pii-redactor';
import { runV2 } from './candidate-poller';

const TENANT_ID = 'test-k4w2';
const DB_URL = process.env.COLD_TIER_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

// ---- InMemoryStorageBackend (mismo patrón que bundle-store.test.ts) ----
class InMemoryStorageBackend implements BundleStorageBackend {
  versions = new Map<string, { content: string; generation: bigint }[]>();
  private nextGeneration = 1n;

  async read(path: string): Promise<ReadResult | null> {
    const list = this.versions.get(path);
    if (!list || list.length === 0) return null;
    const latest = list[list.length - 1];
    return { content: latest.content, generation: latest.generation };
  }

  async list(prefix: string): Promise<StoredObjectMeta[]> {
    const out: StoredObjectMeta[] = [];
    for (const [path, list] of this.versions.entries()) {
      if (path.startsWith(prefix) && list.length > 0) {
        out.push({ path, generation: list[list.length - 1].generation });
      }
    }
    return out;
  }

  async save(path: string, content: string, opts?: { ifGenerationMatch?: bigint }): Promise<bigint> {
    const list = this.versions.get(path) ?? [];
    const currentGeneration = list.length > 0 ? list[list.length - 1].generation : 0n;
    if (opts?.ifGenerationMatch !== undefined && opts.ifGenerationMatch !== currentGeneration) {
      const err: any = new Error('generation mismatch');
      err.code = 'GENERATION_MISMATCH';
      throw err;
    }
    const generation = this.nextGeneration++;
    list.push({ content, generation });
    this.versions.set(path, list);
    return generation;
  }
}

// ---- LLMs simulados ----
let distillCallCount = 0;
const throwingSourceRef = 'conv:thread-error';

function makeFixedDistillerLlm(): DistillerLlm {
  return {
    async generate(prompt: string): Promise<string> {
      distillCallCount++;
      if (prompt.includes(throwingSourceRef)) {
        throw new Error('distiller simulado: fallo forzado para el caso de error');
      }

      // Extrae el source_ref del prompt para dar títulos distintos por candidate y evitar
      // colisiones de slug no deseadas entre los 2 candidates 'drafted' esperados.
      const match = prompt.match(/source_ref:\s*(\S+)/);
      const ref = match ? match[1] : 'unknown';
      const title = `Concepto de prueba ${ref}`;

      return JSON.stringify({
        type: 'Insight',
        title,
        description: 'Descripción de prueba para K4-W2',
        tags: ['c-comercial', 'prueba'],
        timestamp: '2026-07-01T10:00:00.000Z',
        sources: [ref],
        confidence: 'draft',
        pii: 'clean',
        altitude: 2,
        body: 'Cuerpo de prueba denso y accionable para el test de integración de K4-W2.',
      });
    },
  };
}

const noopPiiLlm: PiiLlm = {
  async detectSpans() {
    return [];
  },
};

async function cleanupTenant(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM knowledge_candidates WHERE tenant_id = $1', [TENANT_ID]);
    await client.query('DELETE FROM okf_provenance WHERE tenant_id = $1', [TENANT_ID]);
    await client.query('DELETE FROM okf_concepts WHERE tenant_id = $1', [TENANT_ID]);
    await client.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT_ID]);
  } finally {
    client.release();
  }
}

async function seedCandidate(
  pool: Pool,
  opts: { sourceRef: string; status?: string; kind?: string; payloadSummary?: string }
): Promise<string> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO knowledge_candidates (tenant_id, kind, source_ref, payload_summary, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        TENANT_ID,
        opts.kind ?? 'conversation_closed',
        opts.sourceRef,
        opts.payloadSummary ?? `resumen de prueba para ${opts.sourceRef}`,
        opts.status ?? 'pending',
      ]
    );
    return res.rows[0].id;
  } finally {
    client.release();
  }
}

/**
 * Siembra el escenario "fuente ya consolidada en un concepto vivo" (okf_provenance), que es
 * el otro camino de isDuplicateSource en processCandidate.
 *
 * NOTA (K4-W4 v2): antes de la migración 005 este test sembraba el duplicado como un SEGUNDO
 * candidate 'pending' con el mismo source_ref que otro ya 'drafted'. Desde la migración 005
 * existe el índice único parcial `(tenant_id, source_ref) WHERE status IN
 * ('pending','processing','drafted')`, que ahora impide a nivel de BD que dos candidates
 * activos compartan source_ref -- el INSERT de ese segundo candidate violaría la constraint
 * (23505). En producción esto es la garantía correcta: el flujo pull (candidate-discovery,
 * K4-W4) nunca llega a crear el duplicado porque usa `ON CONFLICT DO NOTHING` sobre este mismo
 * índice. El camino de duplicado por `okf_provenance` (fuente ya consolidada en un concepto
 * vivo, ej. tras un merge del Night Worker) NO está cubierto por el índice y sigue siendo un
 * escenario real y vigente para `isDuplicateSource`, así que se usa aquí en su lugar.
 */
async function seedProvenance(pool: Pool, sourceRef: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO okf_provenance (tenant_id, concept_path, source_ref) VALUES ($1, $2, $3)`,
      [TENANT_ID, 'c-comercial/concepto-existente.md', sourceRef]
    );
  } finally {
    client.release();
  }
}

test('K4-W2 candidate-poller: runV2 procesa candidates, descarta duplicados y es idempotente', async () => {
  const pool = new Pool({ connectionString: DB_URL });

  try {
    await cleanupTenant(pool);

    // Fuente ya consolidada en un concepto vivo (okf_provenance) -- ver seedProvenance para
    // por qué ya no se sembra como un segundo candidate 'drafted' con el mismo source_ref
    // (migración 005, K4-W4 v2).
    const previousDraftedRef = 'conv:thread-already-drafted';
    await seedProvenance(pool, previousDraftedRef);

    // 2 candidates 'pending' con source_ref distintos (deben terminar 'drafted').
    const refA = 'conv:thread-a';
    const refB = 'conv:thread-b';
    await seedCandidate(pool, { sourceRef: refA });
    await seedCandidate(pool, { sourceRef: refB });

    // 1 candidate 'pending' que duplica el source_ref ya consolidado en okf_provenance
    // (debe 'discarded').
    const duplicateId = await seedCandidate(pool, { sourceRef: previousDraftedRef });

    const backend = new InMemoryStorageBackend();
    const store = new BundleStore({ tenantId: TENANT_ID, storage: backend });

    const result = await runV2({
      tenantId: TENANT_ID,
      pool,
      store,
      distillerLlm: makeFixedDistillerLlm(),
      piiLlm: noopPiiLlm,
    });

    // `discovered` ahora siempre viene: el paso 0 dejó de ser condicional. Este tenant no
    // siembra documentos, así que descubre 0 — pero que el campo esté es la prueba de que el
    // descubrimiento corre en cada runV2, que antes no pasaba nunca.
    assert.deepEqual(result, { drafted: 2, discarded: 1, errors: 0, discovered: { documents: 0 } });

    // 2 archivos en _staging/{hoy}/ en el storage simulado.
    const today = new Date().toISOString().slice(0, 10);
    const stagedFiles = await store.list(`_staging/${today}/`);
    assert.equal(stagedFiles.length, 2);

    // Candidates actualizados en BD.
    const client = await pool.connect();
    let statuses: Record<string, string>;
    try {
      const res = await client.query(
        'SELECT source_ref, status FROM knowledge_candidates WHERE tenant_id = $1',
        [TENANT_ID]
      );
      statuses = Object.fromEntries(res.rows.map((r: any) => [r.source_ref + ':' + r.status, true]));
      const byId = await client.query('SELECT status FROM knowledge_candidates WHERE id = $1', [duplicateId]);
      assert.equal(byId.rows[0].status, 'discarded');
    } finally {
      client.release();
    }
    assert.ok(statuses[`${refA}:drafted`]);
    assert.ok(statuses[`${refB}:drafted`]);

    // Re-correr runV2: no debe haber nada pending -> {drafted:0, discarded:0, errors:0}
    // (idempotencia, invariante WORKFLOWS §2.3).
    const secondResult = await runV2({
      tenantId: TENANT_ID,
      pool,
      store,
      distillerLlm: makeFixedDistillerLlm(),
      piiLlm: noopPiiLlm,
    });
    assert.deepEqual(secondResult, { drafted: 0, discarded: 0, errors: 0, discovered: { documents: 0 } });

    // No se agregaron archivos nuevos a _staging tras la re-corrida.
    const stagedFilesAfterRerun = await store.list(`_staging/${today}/`);
    assert.equal(stagedFilesAfterRerun.length, 2);
  } finally {
    await cleanupTenant(pool);
    await pool.end();
  }
});

test('K4-W2 candidate-poller: un candidate cuyo distiller lanza queda en error, los demás se procesan', async () => {
  const pool = new Pool({ connectionString: DB_URL });

  try {
    await cleanupTenant(pool);

    const okRef = 'conv:thread-ok';
    const errorCandidateId = await seedCandidate(pool, { sourceRef: throwingSourceRef });
    await seedCandidate(pool, { sourceRef: okRef });

    const backend = new InMemoryStorageBackend();
    const store = new BundleStore({ tenantId: TENANT_ID, storage: backend });

    const result = await runV2({
      tenantId: TENANT_ID,
      pool,
      store,
      distillerLlm: makeFixedDistillerLlm(),
      piiLlm: noopPiiLlm,
    });

    assert.equal(result.drafted, 1);
    assert.equal(result.discarded, 0);
    assert.equal(result.errors, 1);

    const client = await pool.connect();
    try {
      const res = await client.query(
        'SELECT status, error FROM knowledge_candidates WHERE id = $1',
        [errorCandidateId]
      );
      assert.equal(res.rows[0].status, 'error');
      assert.ok(res.rows[0].error && res.rows[0].error.length > 0);
    } finally {
      client.release();
    }
  } finally {
    await cleanupTenant(pool);
    await pool.end();
  }
});
