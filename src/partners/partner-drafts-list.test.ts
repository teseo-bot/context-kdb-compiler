/**
 * KL3-W1: Tests dirigidos para listado y lectura de drafts de aliado.
 *
 * Scope (pedido por la WU):
 *  1. Ingesta de 2 drafts → listPartnerDrafts devuelve 2.
 *  2. Publicar-simulado (fila en el índice fake con ese slug bajo paquetes/{slug}/) → el
 *     listado devuelve 1 (el otro queda excluido, filtro as-built PA2-W4).
 *  3. getPartnerDraft con path fuera de _staging/ → 422.
 *
 * GCS simulado: mismo patrón in-memory que partner-ingest.test.ts / publisher.test.ts.
 * Postgres simulado: fake `MinimalQueryable` en memoria — la WU permite "simular el criterio"
 * en vez de requerir Postgres real (publisher.test.ts sí usa Postgres real vía DATABASE_URL,
 * pero esa dependencia no es necesaria aquí: el criterio de exclusión es un SELECT de una sola
 * tabla con un LIKE, trivialmente simulable).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';
import {
  BundleStore,
  BundleStorageBackend,
  GenerationMismatchError,
  ReadResult,
  StoredObjectMeta,
} from '../infrastructure/bundle-store';
import { listPartnerDrafts, getPartnerDraft, MinimalQueryable } from './partner-drafts-list';

// ==================== GCS simulado (mismo patrón que el resto del repo) ====================

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
      throw new GenerationMismatchError(path);
    }
    const generation = this.nextGeneration++;
    list.push({ content, generation });
    this.versions.set(path, list);
    return generation;
  }
}

// ==================== Índice okf_partner_concepts simulado ====================

class FakePartnerConceptsIndex implements MinimalQueryable {
  rows: { partner_id: string; gcs_path: string }[] = [];

  async query(text: string, values?: unknown[]): Promise<{ rows: any[] }> {
    // Simula exactamente `SELECT DISTINCT gcs_path FROM okf_partner_concepts WHERE
    // partner_id = $1 AND gcs_path LIKE $2` — el único query que emite partner-drafts-list.ts.
    const [partnerId, likePattern] = values as [string, string];
    const regex = new RegExp(
      '^' + likePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'
    );
    const matched = this.rows.filter((r) => r.partner_id === partnerId && regex.test(r.gcs_path));
    const distinct = Array.from(new Set(matched.map((r) => r.gcs_path)));
    return { rows: distinct.map((gcs_path) => ({ gcs_path })) };
  }
}

// ==================== Fixtures ====================

function draftMarkdown(opts: { title: string; system?: string }): string {
  const fm = {
    type: 'Insight',
    title: opts.title,
    description: 'Descripción de prueba',
    tags: [opts.system ?? 'l-legal'],
    timestamp: '2026-07-08T10:00:00Z',
    sources: ['conv:demo-thread-1'],
    confidence: 'draft',
    pii: 'clean',
    altitude: 2,
  };
  const yamlStr = yaml.dump(fm, { schema: yaml.JSON_SCHEMA });
  return `---\n${yamlStr}---\n\nCuerpo de prueba.`;
}

const TEST_PARTNER_ID = '550e8400-e29b-41d4-a716-446655440099';

test('KL3-W1: 2 drafts en _staging/ → listPartnerDrafts devuelve 2', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const pool = new FakePartnerConceptsIndex();

  await store.write('_staging/2026-07-08/concepto-uno.md', draftMarkdown({ title: 'Concepto Uno' }), {
    actor: 'test', accion: 'draft',
  });
  await store.write('_staging/2026-07-08/concepto-dos.md', draftMarkdown({ title: 'Concepto Dos' }), {
    actor: 'test', accion: 'draft',
  });

  const result = await listPartnerDrafts({ partner_id: TEST_PARTNER_ID }, store, pool);

  assert.equal(result.drafts.length, 2);
  const titles = result.drafts.map((d) => d.title).sort();
  assert.deepEqual(titles, ['Concepto Dos', 'Concepto Uno']);
  const one = result.drafts.find((d) => d.title === 'Concepto Uno')!;
  assert.equal(one.path, '_staging/2026-07-08/concepto-uno.md');
  assert.equal(one.type, 'Insight');
  assert.equal(one.system, 'l-legal');
  assert.equal(one.altitude, 2);
  assert.equal(one.pii, 'clean');
  assert.equal(one.confidence, 'draft');
  assert.equal(one.updated, '2026-07-08T10:00:00Z');
});

test('KL3-W1: draft ya publicado (índice fake) → listPartnerDrafts lo excluye [PA2-W4]', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const pool = new FakePartnerConceptsIndex();

  await store.write('_staging/2026-07-08/concepto-uno.md', draftMarkdown({ title: 'Concepto Uno' }), {
    actor: 'test', accion: 'draft',
  });
  await store.write('_staging/2026-07-08/concepto-dos.md', draftMarkdown({ title: 'Concepto Dos' }), {
    actor: 'test', accion: 'draft',
  });

  // publicar-simulado: publisher.ts escribe paquetes/{package_slug}/{slug}.md y una fila del
  // índice con gcs_path = ese path. Simulamos solo la fila del índice (lo único que
  // listPartnerDrafts consulta) para "concepto-uno".
  pool.rows.push({ partner_id: TEST_PARTNER_ID, gcs_path: 'paquetes/demo-package/concepto-uno.md' });

  const result = await listPartnerDrafts({ partner_id: TEST_PARTNER_ID, package_slug: 'demo-package' }, store, pool);

  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].title, 'Concepto Dos');
});

test('KL3-W1: getPartnerDraft con path fuera de _staging/ → 422', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  await assert.rejects(
    () => getPartnerDraft({ partner_id: TEST_PARTNER_ID, draft_path: 'paquetes/demo/concepto.md' }, store),
    (err: any) => {
      assert.equal(err.code, 422);
      return true;
    }
  );
});

test('KL3-W1: getPartnerDraft con path válido → devuelve el markdown', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const markdown = draftMarkdown({ title: 'Concepto Leído' });
  await store.write('_staging/2026-07-08/concepto-leido.md', markdown, { actor: 'test', accion: 'draft' });

  const result = await getPartnerDraft(
    { partner_id: TEST_PARTNER_ID, draft_path: '_staging/2026-07-08/concepto-leido.md' },
    store
  );

  assert.equal(result.markdown, markdown);
});

test('KL3-W1: getPartnerDraft con path inexistente bajo _staging/ → 404', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  await assert.rejects(
    () => getPartnerDraft({ partner_id: TEST_PARTNER_ID, draft_path: '_staging/2026-07-08/no-existe.md' }, store),
    (err: any) => {
      assert.equal(err.code, 404);
      return true;
    }
  );
});
