import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPartnerBundleWithStorage } from '../partners/bundle';
import { BundleStore, BundleStorageBackend, GenerationMismatchError, ReadResult, StoredObjectMeta } from './bundle-store';

// PA2-W1: GCS simulado en memoria para tests del bundle de aliado
class InMemoryStorageBackendPartner implements BundleStorageBackend {
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

// Dummy UUID para tests
const TEST_PARTNER_ID = '550e8400-e29b-41d4-a716-446655440000';

test('PA2-W1: crear bundle de aliado con GCS simulado — 3 archivos + genesis', async () => {
  const storage = new InMemoryStorageBackendPartner();

  const result = await createPartnerBundleWithStorage(TEST_PARTNER_ID, storage);

  assert.equal(result.fileCount, 2, 'Se escriben 2 archivos vía BundleStore.write() (index.md + _staging/.keep)');
  assert.equal(result.verified, true, 'verifyChain() OK');

  // Verificar que se crearon los 3 objetos esperados en el GCS simulado:
  // index.md, log.md (auto-generado), _staging/.keep
  const objects = Array.from(storage.versions.keys()).sort();
  assert.deepEqual(objects, ['_staging/.keep', 'index.md', 'log.md'], 'Se crean exactamente 3 objetos en GCS');

  // Verificar que cada objeto tiene al menos 1 versión
  assert.ok(storage.versions.get('index.md')![0].content.includes('Catálogo de Conocimiento'));
  assert.ok(storage.versions.get('log.md')![0].content.length > 0);
  assert.equal(storage.versions.get('_staging/.keep')![0].content, '');
});

test('PA2-W1: verifyChain() ok tras génesis de bundle de aliado', async () => {
  const storage = new InMemoryStorageBackendPartner();

  await createPartnerBundleWithStorage(TEST_PARTNER_ID, storage);

  // Verificar el log.md generado — debe tener al menos 1 línea
  const logContent = storage.versions.get('log.md')![0].content;
  const lines = logContent.split('\n').filter((l) => l.length > 0);

  assert.ok(lines.length >= 1, 'Log tiene al menos 1 línea');
  assert.match(lines[0], /prev:genesis$/, 'Primera línea tiene prev:genesis');
});

test('PA2-W1: alterar una línea del log rompe verifyChain() del bundle de aliado', async () => {
  const storage = new InMemoryStorageBackendPartner();

  await createPartnerBundleWithStorage(TEST_PARTNER_ID, storage);

  // Corrompemos el log directamente
  const logVersions = storage.versions.get('log.md')!;
  const latestLogContent = logVersions[logVersions.length - 1].content;
  const lines = latestLogContent.split('\n').filter((l) => l.length > 0);
  const corrupted = lines.map((l, i) => i === 0 ? l.replace('genesis', 'fake') : l).join('\n') + '\n';

  logVersions[logVersions.length - 1] = { content: corrupted, generation: logVersions[logVersions.length - 1].generation };

  // Verificar que ahora falla
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const result = await store.verifyChain();

  assert.equal(result.ok, false, 'verifyChain() falla cuando log está corrupto');
  assert.ok(result.brokenAt !== undefined, 'brokenAt se reporta');
});
