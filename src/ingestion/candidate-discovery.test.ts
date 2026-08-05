// K4-W4 v2: test de integración de candidate-discovery contra el Postgres local
// (postgres://postgres:postgres@localhost:5436/postgres, migraciones 001-005 aplicadas).
//
// Sembrado como usuario 'postgres' (owner de las tablas, bypassa RLS) para no depender de
// SET app.tenant_id al insertar filas de prueba; discoverCandidates SÍ ejecuta
// SET app.tenant_id en la conexión que toma del pool, que es lo que se está verificando
// funcionalmente (igual que candidate-poller.test.ts, K4-W2).
//
// Ya no hay fetch mock de Supabase: la fuente de conversaciones se retiró con la fuente
// misma (ver cabecera de candidate-discovery.ts). Los tests que quedan ejercitan la única
// fuente que existe —documentos sin candidate— contra Postgres real, sin dobles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { discoverCandidates } from './candidate-discovery';

const TENANT_ID = 'test-k4w4';
const DB_URL = process.env.COLD_TIER_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

async function cleanupTenant(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM knowledge_candidates WHERE tenant_id = $1', [TENANT_ID]);
    await client.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT_ID]);
  } finally {
    client.release();
  }
}

test('K4-W4 candidate-discovery: descubre documentos sin candidate y es idempotente', async () => {
  const pool = new Pool({ connectionString: DB_URL });

  const HASH_NUEVO = 'a'.repeat(64);
  const HASH_YA_DESCUBIERTO = 'd'.repeat(64);

  try {
    await cleanupTenant(pool);

    const client = await pool.connect();
    try {
      // Documento sin candidate -> debe generar 1 candidate document_ingested.
      await client.query(
        `INSERT INTO documents (tenant_id, document_hash, filename, content)
         VALUES ($1, $2, $3, $4)`,
        [TENANT_ID, HASH_NUEVO, 'manual-onboarding.pdf', 'contenido de prueba']
      );

      // Documento que YA tiene candidate de una corrida previa: el NOT EXISTS debe excluirlo
      // aunque su candidate esté en un status distinto de 'pending'.
      await client.query(
        `INSERT INTO documents (tenant_id, document_hash, filename, content)
         VALUES ($1, $2, $3, $4)`,
        [TENANT_ID, HASH_YA_DESCUBIERTO, 'ya-procesado.pdf', 'contenido ya procesado']
      );
      await client.query(
        `INSERT INTO knowledge_candidates (tenant_id, kind, source_ref, payload_summary, status)
         VALUES ($1, 'document_ingested', $2, 'ya descubierto en corrida previa', 'drafted')`,
        [TENANT_ID, `doc:sha256:${HASH_YA_DESCUBIERTO}`]
      );
    } finally {
      client.release();
    }

    const result = await discoverCandidates({ tenantId: TENANT_ID, coldPool: pool });
    assert.deepEqual(result, { documents: 1 });

    const client2 = await pool.connect();
    let rows: { source_ref: string; kind: string; status: string }[];
    try {
      const res = await client2.query(
        `SELECT source_ref, kind, status FROM knowledge_candidates WHERE tenant_id = $1 ORDER BY source_ref`,
        [TENANT_ID]
      );
      rows = res.rows;
    } finally {
      client2.release();
    }

    const docCandidate = rows.find((r) => r.source_ref === `doc:sha256:${HASH_NUEVO}`);
    assert.ok(docCandidate, 'documento sin candidate debe generar candidate document_ingested');
    assert.equal(docCandidate!.kind, 'document_ingested');
    assert.equal(docCandidate!.status, 'pending');

    // El candidate previo sigue existiendo una sola vez y conserva su status.
    const previos = rows.filter((r) => r.source_ref === `doc:sha256:${HASH_YA_DESCUBIERTO}`);
    assert.equal(previos.length, 1);
    assert.equal(previos[0].status, 'drafted');

    // Re-corrida: 0 nuevos (idempotencia).
    const secondResult = await discoverCandidates({ tenantId: TENANT_ID, coldPool: pool });
    assert.deepEqual(secondResult, { documents: 0 });

    const client3 = await pool.connect();
    try {
      const res = await client3.query('SELECT count(*)::int AS n FROM knowledge_candidates WHERE tenant_id = $1', [
        TENANT_ID,
      ]);
      assert.equal(res.rows[0].n, 2);
    } finally {
      client3.release();
    }
  } finally {
    await cleanupTenant(pool);
    await pool.end();
  }
});

test('K9-W1 candidate-discovery: copia documents.metadata.hocflit_hint al candidate.metadata', async () => {
  const pool = new Pool({ connectionString: DB_URL });
  const TENANT_K9 = 'test-k9w1-discovery';

  async function cleanupK9(p: Pool) {
    const client = await p.connect();
    try {
      await client.query('DELETE FROM knowledge_candidates WHERE tenant_id = $1', [TENANT_K9]);
      await client.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT_K9]);
    } finally {
      client.release();
    }
  }

  try {
    await cleanupK9(pool);

    const hint = { system: 'c-comercial', tags: ['pricing'], source_module: 'crm-comercial' };

    const client = await pool.connect();
    try {
      // Documento CON hint en metadata.
      await client.query(
        `INSERT INTO documents (tenant_id, document_hash, filename, content, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [TENANT_K9, 'b'.repeat(64), 'pricing.pdf', 'contenido con hint', JSON.stringify({ hocflit_hint: hint })]
      );
      // Documento SIN hint en metadata (caso "solo si existe").
      await client.query(
        `INSERT INTO documents (tenant_id, document_hash, filename, content, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [TENANT_K9, 'c'.repeat(64), 'sin-hint.pdf', 'contenido sin hint', JSON.stringify({})]
      );
    } finally {
      client.release();
    }

    const result = await discoverCandidates({ tenantId: TENANT_K9, coldPool: pool });
    assert.deepEqual(result, { documents: 2 });

    const client2 = await pool.connect();
    let rows: { source_ref: string; metadata: unknown }[];
    try {
      const res = await client2.query(
        `SELECT source_ref, metadata FROM knowledge_candidates WHERE tenant_id = $1 ORDER BY source_ref`,
        [TENANT_K9]
      );
      rows = res.rows;
    } finally {
      client2.release();
    }

    const withHint = rows.find((r) => r.source_ref === `doc:sha256:${'b'.repeat(64)}`);
    const withoutHint = rows.find((r) => r.source_ref === `doc:sha256:${'c'.repeat(64)}`);

    assert.ok(withHint, 'candidate del documento con hint debe existir');
    assert.deepEqual((withHint!.metadata as any).hocflit_hint, hint);

    assert.ok(withoutHint, 'candidate del documento sin hint debe existir');
    assert.equal((withoutHint!.metadata as any)?.hocflit_hint, undefined);
  } finally {
    await cleanupK9(pool);
    await pool.end();
  }
});
