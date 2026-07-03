// K4-W4 v2: test de integración de candidate-discovery contra el Postgres local
// (postgres://postgres:postgres@localhost:5436/postgres, migraciones 001-005 aplicadas) +
// fetch mock de Supabase (REST PostgREST) inyectado vía `fetchImpl`.
//
// Sembrado como usuario 'postgres' (owner de las tablas, bypassa RLS) para no depender de
// SET app.tenant_id al insertar filas de prueba; discoverCandidates SÍ ejecuta
// SET app.tenant_id en la conexión que toma del pool, que es lo que se está verificando
// funcionalmente (igual que candidate-poller.test.ts, K4-W2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { discoverCandidates, SupabaseRestConfig } from './candidate-discovery';

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

/**
 * Fetch mock de Supabase PostgREST: responde a GET {url}/rest/v1/leads?... con las filas
 * fijas de la siembra de este test. Verifica que se manden los headers apikey/Authorization
 * y el filtro tenant_id.
 */
function makeFakeSupabaseFetch(leads: any[]): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    assert.ok(url.includes('/rest/v1/leads'), `URL inesperada: ${url}`);
    assert.ok(url.includes(`tenant_id=eq.${TENANT_ID}`), `falta filtro tenant_id: ${url}`);
    assert.equal(init?.headers?.apikey, 'fake-service-key');
    assert.equal(init?.headers?.Authorization, 'Bearer fake-service-key');

    return {
      ok: true,
      status: 200,
      json: async () => leads,
      text: async () => JSON.stringify(leads),
    } as Response;
  }) as unknown as typeof fetch;
}

// ---- Siembra de leads (Hot-Tier simulado vía fetch mock) ----
// - lead-won: status='Won' (capitalizado, como escribe el Kanban) -> terminal por status.
// - lead-resolved: status='Contacted' (no terminal) pero pipeline_status='resolved'
//   (como escribe el handoff route) -> terminal por pipeline_status.
// - lead-open: status='Contacted', pipeline_status='new' -> NO terminal, no genera candidate.
// - lead-already-discovered: status='Lost' (terminal) pero YA existe un candidate 'pending'
//   con ese source_ref -> ON CONFLICT DO NOTHING, no debe duplicar.
const LEAD_WON = { id: 'lead-won', thread_id: 'thread-won', status: 'Won', pipeline_status: 'new' };
const LEAD_RESOLVED = {
  id: 'lead-resolved',
  thread_id: 'thread-resolved',
  status: 'Contacted',
  pipeline_status: 'resolved',
};
const LEAD_OPEN = { id: 'lead-open', thread_id: 'thread-open', status: 'Contacted', pipeline_status: 'new' };
const LEAD_ALREADY_DISCOVERED = {
  id: 'lead-already-discovered',
  thread_id: 'thread-already-discovered',
  status: 'Lost',
  pipeline_status: 'new',
};

const ALL_LEADS = [LEAD_WON, LEAD_RESOLVED, LEAD_OPEN, LEAD_ALREADY_DISCOVERED];

test('K4-W4 candidate-discovery: descubre leads cerrados y documentos sin candidate, es idempotente', async () => {
  const pool = new Pool({ connectionString: DB_URL });

  try {
    await cleanupTenant(pool);

    const client = await pool.connect();
    try {
      // Candidate ya descubierto para LEAD_ALREADY_DISCOVERED (simula una corrida previa):
      // debe bloquear el re-descubrimiento vía ON CONFLICT DO NOTHING sobre el índice único
      // parcial de la migración 005.
      await client.query(
        `INSERT INTO knowledge_candidates (tenant_id, kind, source_ref, payload_summary, status)
         VALUES ($1, 'conversation_closed', $2, 'ya descubierto en corrida previa', 'pending')`,
        [TENANT_ID, `conv:${LEAD_ALREADY_DISCOVERED.thread_id}`]
      );

      // 1 documento sin candidate -> debe generar 1 candidate document_ingested.
      await client.query(
        `INSERT INTO documents (tenant_id, document_hash, filename, content)
         VALUES ($1, $2, $3, $4)`,
        [TENANT_ID, 'a'.repeat(64), 'manual-onboarding.pdf', 'contenido de prueba']
      );
    } finally {
      client.release();
    }

    const supabase: SupabaseRestConfig = {
      url: 'https://fake-project.supabase.co',
      serviceKey: 'fake-service-key',
      fetchImpl: makeFakeSupabaseFetch(ALL_LEADS),
    };

    const result = await discoverCandidates({
      tenantId: TENANT_ID,
      coldPool: pool,
      supabase,
    });

    // Siembra: 4 leads -> 3 terminales (won, resolved, already-discovered) de los cuales 1
    // ya tenía candidate -> 2 candidates NUEVOS de conversación. 1 documento sin candidate
    // -> 1 candidate nuevo de documento.
    assert.deepEqual(result, { conversations: 2, documents: 1 });

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

    const bySourceRef = Object.fromEntries(rows.map((r) => [r.source_ref, r]));

    assert.ok(bySourceRef[`conv:${LEAD_WON.thread_id}`], 'lead won debe generar candidate');
    assert.equal(bySourceRef[`conv:${LEAD_WON.thread_id}`].kind, 'conversation_closed');
    assert.equal(bySourceRef[`conv:${LEAD_WON.thread_id}`].status, 'pending');

    assert.ok(bySourceRef[`conv:${LEAD_RESOLVED.thread_id}`], 'lead resolved debe generar candidate');

    assert.ok(!bySourceRef[`conv:${LEAD_OPEN.thread_id}`], 'lead abierto NO debe generar candidate');

    // El candidate de LEAD_ALREADY_DISCOVERED sigue existiendo una sola vez (no se duplicó).
    const alreadyDiscoveredRows = rows.filter(
      (r) => r.source_ref === `conv:${LEAD_ALREADY_DISCOVERED.thread_id}`
    );
    assert.equal(alreadyDiscoveredRows.length, 1);

    const docCandidate = rows.find((r) => r.source_ref === `doc:sha256:${'a'.repeat(64)}`);
    assert.ok(docCandidate, 'documento sin candidate debe generar candidate document_ingested');
    assert.equal(docCandidate!.kind, 'document_ingested');

    // Re-corrida: 0 nuevos (idempotencia total, tanto conversaciones como documentos).
    const secondResult = await discoverCandidates({
      tenantId: TENANT_ID,
      coldPool: pool,
      supabase: { ...supabase, fetchImpl: makeFakeSupabaseFetch(ALL_LEADS) },
    });
    assert.deepEqual(secondResult, { conversations: 0, documents: 0 });

    const client3 = await pool.connect();
    try {
      const res = await client3.query('SELECT count(*)::int AS n FROM knowledge_candidates WHERE tenant_id = $1', [
        TENANT_ID,
      ]);
      // 3 candidates de conversación (won, resolved, already-discovered) + 1 de documento = 4.
      assert.equal(res.rows[0].n, 4);
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

    // Fetch mock local (no se reutiliza makeFakeSupabaseFetch: esa cierra sobre el TENANT_ID
    // del módulo, distinto de TENANT_K9 usado en este test).
    const localFetch: typeof fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '[]',
      }) as unknown as Response) as unknown as typeof fetch;

    const supabase: SupabaseRestConfig = {
      url: 'https://fake-project.supabase.co',
      serviceKey: 'fake-service-key',
      fetchImpl: localFetch,
    };

    const result = await discoverCandidates({ tenantId: TENANT_K9, coldPool: pool, supabase });
    assert.deepEqual(result, { conversations: 0, documents: 2 });

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

test('K4-W4 candidate-discovery: propaga error si Supabase responde no-ok', async () => {
  const pool = new Pool({ connectionString: DB_URL });

  try {
    await cleanupTenant(pool);

    const failingFetch: typeof fetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'internal error simulado',
      }) as unknown as Response) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        discoverCandidates({
          tenantId: TENANT_ID,
          coldPool: pool,
          supabase: { url: 'https://fake-project.supabase.co', serviceKey: 'fake-service-key', fetchImpl: failingFetch },
        }),
      /Supabase leads query fallo \(500\)/
    );
  } finally {
    await cleanupTenant(pool);
    await pool.end();
  }
});
