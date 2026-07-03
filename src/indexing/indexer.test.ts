// K3-W2 (PLAN-OKF-Epicas-K.md, sección K3-W2; BACKEND §A8): tests de integración del
// indexador delta contra Postgres local (RLS FORCE activo, sembrado como owner `postgres`)
// y un BundleStore con storage en memoria + EmbeddingsClient mock de 768 dims.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import matter from 'gray-matter';
import { BundleStore, BundleStorageBackend, ReadResult, StoredObjectMeta } from '../infrastructure/bundle-store';
import { EmbeddingsClient, EMBEDDING_DIM } from '../infrastructure/embeddings';
import { indexDelta } from './indexer';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

// --- Storage en memoria (mismo patrón que bundle-store.test.ts) -----------------------------
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

  async save(path: string, content: string, _opts?: { ifGenerationMatch?: bigint }): Promise<bigint> {
    const list = this.versions.get(path) ?? [];
    const generation = this.nextGeneration++;
    list.push({ content, generation });
    this.versions.set(path, list);
    return generation;
  }

  // Helper de test: simula una nueva versión de un objeto (nueva generation) sin pasar por
  // BundleStore.write (que exigiría frontmatter válido en log.md/etc.) — el indexer solo lee
  // por `store.list`/`store.read`, así que sembrar directo en el backend es suficiente y más
  // simple que reconstruir cadenas de log válidas para cada fixture.
  seed(path: string, content: string) {
    const generation = this.nextGeneration++;
    this.versions.set(path, [{ content, generation }]);
  }
}

class MockEmbeddingsClient768 implements EmbeddingsClient {
  calls: string[][] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => {
      const seed = t.length;
      return new Array(EMBEDDING_DIM).fill(0).map((_, i) => (Math.sin(seed + i) + 1) / 2);
    });
  }
}

function conceptContent(opts: {
  title: string;
  description: string;
  body: string;
  sources: string[];
  tags: string[];
  altitude?: number;
}): string {
  return matter.stringify(opts.body, {
    type: 'Insight',
    title: opts.title,
    description: opts.description,
    tags: opts.tags,
    timestamp: '2026-07-01T10:00:00.000Z',
    sources: opts.sources,
    confidence: 'draft',
    pii: 'clean',
    altitude: opts.altitude ?? 2,
  });
}

// Un tenant_id distinto por test (misma corrida) para evitar interferencia entre tests:
// cada test usa su propio InMemoryStorageBackend (generations reinician en 1n), así que
// compartir tenant_id entre tests haría que el segundo "indexDelta" viera filas de
// okf_concepts de OTRO backend con generation ya distinta y las tratara como cambiadas.
const RUN_ID = randomUUID().slice(0, 8);
const TENANT_SEED = `k3w2-seed-${RUN_ID}`;
const TENANT_RERUN = `k3w2-rerun-${RUN_ID}`;
const TENANT_MODIFY = `k3w2-modify-${RUN_ID}`;
const ALL_TEST_TENANTS = [TENANT_SEED, TENANT_RERUN, TENANT_MODIFY];

let pool: Pool;

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

after(async () => {
  // LIMPIEZA: borrar todos los datos de los tenants de test, como owner postgres (sin RLS).
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM okf_provenance WHERE tenant_id = ANY($1::text[])', [ALL_TEST_TENANTS]);
    await client.query('DELETE FROM okf_edges WHERE tenant_id = ANY($1::text[])', [ALL_TEST_TENANTS]);
    await client.query('DELETE FROM okf_concepts WHERE tenant_id = ANY($1::text[])', [ALL_TEST_TENANTS]);
  } finally {
    client.release();
  }
  await pool.end();
});

test('indexDelta: 3 conceptos nuevos en c-comercial/ -> indexed>=3, skipped:0; filas correctas en okf_concepts/okf_edges/okf_provenance', async () => {
  const backend = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TENANT_SEED, storage: backend });
  const embeddings = new MockEmbeddingsClient768();

  backend.seed(
    'c-comercial/concepto-uno.md',
    conceptContent({
      title: 'Concepto Uno',
      description: 'Primer concepto de prueba',
      body: 'Cuerpo del concepto uno. Ver también [otro concepto](/f-finanzas/otro.md) para más contexto.',
      sources: ['conv:t1'],
      tags: ['c-comercial', 'ventas'],
    })
  );
  backend.seed(
    'c-comercial/concepto-dos.md',
    conceptContent({
      title: 'Concepto Dos',
      description: 'Segundo concepto de prueba',
      body: 'Cuerpo del concepto dos, sin cross-links.',
      sources: ['conv:t2'],
      tags: ['c-comercial', 'ventas'],
    })
  );
  backend.seed(
    'c-comercial/concepto-tres.md',
    conceptContent({
      title: 'Concepto Tres',
      description: 'Tercer concepto de prueba',
      body: 'Cuerpo del concepto tres.',
      sources: ['conv:t3', 'doc:sha256:' + 'a'.repeat(64)],
      tags: ['c-comercial', 'ventas'],
    })
  );

  const result = await indexDelta(TENANT_SEED, { pool, store, embeddings });

  assert.ok(result.indexed >= 3, `esperaba indexed>=3, obtuve ${result.indexed}`);
  assert.equal(result.skipped, 0);

  const client = await pool.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', TENANT_SEED]);

    const concepts = await client.query(
      `SELECT path, system_slug, embedding IS NOT NULL AS has_embedding, altitude
       FROM okf_concepts WHERE tenant_id = $1 ORDER BY path`,
      [TENANT_SEED]
    );
    assert.equal(concepts.rows.length, 3);
    for (const row of concepts.rows) {
      assert.equal(row.system_slug, 'c-comercial');
      assert.equal(row.has_embedding, true);
      assert.equal(row.altitude, 2);
    }

    const edges = await client.query(
      `SELECT from_path, to_path FROM okf_edges WHERE tenant_id = $1`,
      [TENANT_SEED]
    );
    assert.equal(edges.rows.length, 1);
    assert.equal(edges.rows[0].from_path, 'c-comercial/concepto-uno.md');
    assert.equal(edges.rows[0].to_path, 'f-finanzas/otro.md');

    const provenance = await client.query(
      `SELECT concept_path, source_ref FROM okf_provenance WHERE tenant_id = $1 ORDER BY concept_path, source_ref`,
      [TENANT_SEED]
    );
    assert.equal(provenance.rows.length, 4); // 1 (uno) + 1 (dos) + 2 (tres)
    assert.ok(
      provenance.rows.some(
        (r: any) => r.concept_path === 'c-comercial/concepto-uno.md' && r.source_ref === 'conv:t1'
      )
    );
  } finally {
    await client.query('RESET app.tenant_id');
    client.release();
  }
});

test('indexDelta: re-correr sin cambios -> skipped == total, indexed:0', async () => {
  const backend = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TENANT_RERUN, storage: backend });
  const embeddings = new MockEmbeddingsClient768();

  backend.seed(
    'c-comercial/concepto-uno.md',
    conceptContent({
      title: 'Concepto Uno',
      description: 'Primer concepto de prueba',
      body: 'Cuerpo del concepto uno.',
      sources: ['conv:t1'],
      tags: ['c-comercial', 'ventas'],
    })
  );

  const first = await indexDelta(TENANT_RERUN, { pool, store, embeddings });
  assert.equal(first.indexed, 1);

  const second = await indexDelta(TENANT_RERUN, { pool, store, embeddings });
  assert.equal(second.indexed, 0);
  assert.equal(second.skipped, first.indexed + first.skipped);
});

test('indexDelta: modificar 1 archivo (nueva generation en el mock) -> indexed:1, skipped:resto', async () => {
  const backend = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TENANT_MODIFY, storage: backend });
  const embeddings = new MockEmbeddingsClient768();

  backend.seed(
    'c-comercial/mod-uno.md',
    conceptContent({
      title: 'Mod Uno',
      description: 'desc',
      body: 'cuerpo original',
      sources: ['conv:m1'],
      tags: ['c-comercial'],
    })
  );
  backend.seed(
    'c-comercial/mod-dos.md',
    conceptContent({
      title: 'Mod Dos',
      description: 'desc',
      body: 'cuerpo original 2',
      sources: ['conv:m2'],
      tags: ['c-comercial'],
    })
  );
  backend.seed(
    'c-comercial/mod-tres.md',
    conceptContent({
      title: 'Mod Tres',
      description: 'desc',
      body: 'cuerpo original 3',
      sources: ['conv:m3'],
      tags: ['c-comercial'],
    })
  );

  const first = await indexDelta(TENANT_MODIFY, { pool, store, embeddings });
  assert.equal(first.indexed, 3);
  assert.equal(first.skipped, 0);

  // Modificar solo mod-dos.md: nueva versión con nuevo generation en el mock.
  backend.seed(
    'c-comercial/mod-dos.md',
    conceptContent({
      title: 'Mod Dos',
      description: 'desc actualizada',
      body: 'cuerpo actualizado 2',
      sources: ['conv:m2', 'conv:m2b'],
      tags: ['c-comercial'],
    })
  );

  const second = await indexDelta(TENANT_MODIFY, { pool, store, embeddings });
  assert.equal(second.indexed, 1);
  assert.equal(second.skipped, 2);

  const client = await pool.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', TENANT_MODIFY]);
    const row = await client.query(
      `SELECT body_text FROM okf_concepts WHERE tenant_id = $1 AND path = $2`,
      [TENANT_MODIFY, 'c-comercial/mod-dos.md']
    );
    assert.equal(row.rows[0].body_text.trim(), 'cuerpo actualizado 2');
  } finally {
    await client.query('RESET app.tenant_id');
    client.release();
  }
});
