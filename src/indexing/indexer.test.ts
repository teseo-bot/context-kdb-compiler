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
  confidence?: 'draft' | 'reviewed' | 'consolidated';
  // ADR-215 WU-4.4: `unknown` a propósito — este campo sale de YAML del usuario y los tests de
  // marca necesitan poder sembrar basura (una cadena, un número) para fijar la degradación.
  brands?: unknown;
}): string {
  return matter.stringify(opts.body, {
    type: 'Insight',
    title: opts.title,
    description: opts.description,
    tags: opts.tags,
    timestamp: '2026-07-01T10:00:00.000Z',
    sources: opts.sources,
    confidence: opts.confidence ?? 'draft',
    pii: 'clean',
    altitude: opts.altitude ?? 2,
    ...(opts.brands !== undefined ? { brands: opts.brands } : {}),
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
const TENANT_ORIGIN = `d21013-origin-${RUN_ID}`;
const TENANT_MARCA = `wu44-marca-${RUN_ID}`;
const ALL_TEST_TENANTS = [TENANT_SEED, TENANT_RERUN, TENANT_MODIFY, TENANT_ORIGIN, TENANT_MARCA];

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
      `SELECT from_path, to_path, origin FROM okf_edges WHERE tenant_id = $1`,
      [TENANT_SEED]
    );
    assert.equal(edges.rows.length, 1);
    assert.equal(edges.rows[0].from_path, 'c-comercial/concepto-uno.md');
    assert.equal(edges.rows[0].to_path, 'f-finanzas/otro.md');
    // ADR-210 D-210.13: el concepto es confidence:'draft' (nadie lo ha revisado), así que su
    // arista es una inferencia del destilador, no un vínculo explícito en la fuente.
    assert.equal(edges.rows[0].origin, 'INFERRED');

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

// ── ADR-210 D-210.13: confianza explícita en la arista ─────────────────────────────────────
//
// Lo que este test protege no es la columna, es la CONDICIÓN DE TIEMPO que la motiva: una vez
// que el destilador escriba aristas sin marca, separarlas a posteriori es imposible sin
// re-destilar el corpus. Verifica las dos direcciones (un draft no puede pasar por extraído, y
// un concepto revisado no se queda marcado como inferencia) y, sobre todo, que la promoción
// editorial ASCIENDE la arista existente al reindexar — que es lo que hace que la marca sea
// mantenible sin un paso operativo aparte.
test('D-210.13: origin de la arista sigue a confidence del concepto, y la promoción editorial la asciende', async () => {
  const backend = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TENANT_ORIGIN, storage: backend });
  const embeddings = new MockEmbeddingsClient768();

  const body = 'Cuerpo con un vínculo a [otro concepto](/f-finanzas/otro.md).';
  const draftArgs = {
    title: 'Salido del destilador',
    description: 'Nadie lo ha revisado todavía',
    body,
    sources: ['conv:origin-1'],
    tags: ['c-comercial', 'ventas'],
  };

  // Un concepto en 'draft' (el estado en que el destilador L1 deja todo) junto a uno que un
  // humano ya endosó: las dos marcas tienen que convivir en la misma corrida.
  backend.seed('c-comercial/inferido.md', conceptContent(draftArgs));
  backend.seed(
    'c-comercial/extraido.md',
    conceptContent({
      ...draftArgs,
      title: 'Revisado por un humano',
      description: 'Un curador lo endosó',
      sources: ['conv:origin-2'],
      confidence: 'reviewed',
    })
  );

  await indexDelta(TENANT_ORIGIN, { pool, store, embeddings });

  const readOrigins = async (): Promise<Map<string, string>> => {
    const client = await pool.connect();
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', TENANT_ORIGIN]);
      const { rows } = await client.query(
        `SELECT from_path, origin FROM okf_edges WHERE tenant_id = $1`,
        [TENANT_ORIGIN]
      );
      return new Map(rows.map((r: any) => [r.from_path, r.origin]));
    } finally {
      await client.query('RESET app.tenant_id');
      client.release();
    }
  };

  const before = await readOrigins();
  assert.equal(before.get('c-comercial/inferido.md'), 'INFERRED');
  assert.equal(before.get('c-comercial/extraido.md'), 'EXTRACTED');

  // Promoción editorial: el mismo concepto, ahora endosado. El bundle es append-only, así que
  // esto es una generation nueva y el delta lo reindexa.
  backend.seed(
    'c-comercial/inferido.md',
    conceptContent({ ...draftArgs, confidence: 'consolidated' })
  );

  await indexDelta(TENANT_ORIGIN, { pool, store, embeddings });

  const after = await readOrigins();
  assert.equal(
    after.get('c-comercial/inferido.md'),
    'EXTRACTED',
    'promover el concepto debe ascender su arista en el reindexado, sin paso operativo extra'
  );
  assert.equal(after.get('c-comercial/extraido.md'), 'EXTRACTED');
});

// ADR-215 WU-4.4 — la marca del artefacto baja a `okf_concepts.brand_slugs`.
//
// Sin esto la columna se queda en '{}' para siempre y el filtro de marca del orquestador
// (WU-4.3) queda INERTE: todo parece compartido y las dos marcas leen el mismo corpus. El filtro
// y el escritor sólo sirven juntos.
test('WU-4.4: brand_slugs de okf_concepts sale de frontmatter.brands, se normaliza y sigue al reindexado', async () => {
  const backend = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TENANT_MARCA, storage: backend });
  const embeddings = new MockEmbeddingsClient768();

  const base = {
    description: 'Concepto para probar el eje de marca',
    body: 'Cuerpo sin vínculos.',
    sources: ['conv:marca-1'],
    tags: ['c-comercial', 'ventas'],
  };

  backend.seed('c-comercial/sin-marca.md', conceptContent({ ...base, title: 'Sin marca' }));
  backend.seed(
    'c-comercial/una-marca.md',
    conceptContent({ ...base, title: 'Una marca', brands: ['cargalo'] })
  );
  backend.seed(
    'c-comercial/dos-marcas.md',
    conceptContent({ ...base, title: 'Dos marcas', brands: ['fleetco', 'cargalo'] })
  );
  // Tecleado a mano: mayúsculas, espacios, un vacío y un duplicado. Debe producir exactamente la
  // misma fila que `['cargalo']` — si no, dos conceptos idénticos filtrarían distinto.
  backend.seed(
    'c-comercial/sucia.md',
    conceptContent({ ...base, title: 'Sucia', brands: [' Cargalo ', 'cargalo', ''] })
  );
  // YAML basura: una cadena en vez de un array. Degrada a compartido, no revienta el indexado.
  backend.seed(
    'c-comercial/basura.md',
    conceptContent({ ...base, title: 'Basura', brands: 'cargalo' })
  );

  await indexDelta(TENANT_MARCA, { pool, store, embeddings });

  const readBrands = async (): Promise<Map<string, string[]>> => {
    const client = await pool.connect();
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', TENANT_MARCA]);
      const { rows } = await client.query(
        `SELECT path, brand_slugs FROM okf_concepts WHERE tenant_id = $1`,
        [TENANT_MARCA]
      );
      return new Map(rows.map((r: any) => [r.path, r.brand_slugs]));
    } finally {
      await client.query('RESET app.tenant_id');
      client.release();
    }
  };

  const marcas = await readBrands();
  assert.deepEqual(marcas.get('c-comercial/una-marca.md'), ['cargalo']);
  // Orden estable: la normalización ordena, así que la aserción no depende del orden del YAML.
  assert.deepEqual(marcas.get('c-comercial/dos-marcas.md'), ['cargalo', 'fleetco']);
  assert.deepEqual(
    marcas.get('c-comercial/sucia.md'),
    ['cargalo'],
    'mayúsculas, espacios, vacíos y duplicados deben colapsar a la misma fila'
  );
  assert.deepEqual(marcas.get('c-comercial/sin-marca.md'), [], 'ausente = compartido');
  assert.deepEqual(marcas.get('c-comercial/basura.md'), [], 'YAML no-array = compartido, sin romper');

  // El índice de navegación va SIEMPRE compartido: con marca esconderría a la otra marca TODOS
  // sus hijos, incluidos los compartidos.
  const indice = marcas.get('c-comercial/index.md');
  if (indice !== undefined) {
    assert.deepEqual(indice, [], 'los index.md son andamio de navegación, nunca de una marca');
  }

  // Reetiquetar y reindexar: el bundle es append-only ⇒ generation nueva ⇒ el delta lo revisita.
  // Sin `brand_slugs` en el DO UPDATE esto conservaría la marca vieja, y el reindexado es
  // justamente el camino por el que se corrige una marca mal puesta.
  backend.seed(
    'c-comercial/una-marca.md',
    conceptContent({ ...base, title: 'Una marca', brands: ['fleetco'] })
  );

  await indexDelta(TENANT_MARCA, { pool, store, embeddings });

  const despues = await readBrands();
  assert.deepEqual(
    despues.get('c-comercial/una-marca.md'),
    ['fleetco'],
    'reetiquetar debe sobrescribir la marca en el reindexado, no acumular ni conservar la vieja'
  );
});
