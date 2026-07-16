/**
 * KL2-W1: Tests dirigidos para la subida de fuentes crudas del aliado a `_fuentes/`
 *
 * Scope:
 *  1. Subir bytes → objeto en `_fuentes/{sha256}{ext}` + sha256 calculado sobre el binario real
 *  2. Mismo contenido 2ª vez → mismo sha256, created:false, CERO escrituras nuevas (idempotente)
 *  3. Fuente > 20MB → PartnerSourceTooLargeError
 *  4. El path NO termina en `.md` ⇒ no dispara validación de frontmatter (mismo mecanismo que
 *     `_staging/.keep` del génesis, PA2-W1)
 */

import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BundleStore, BundleStorageBackend, GenerationMismatchError, ReadResult, StoredObjectMeta } from '../infrastructure/bundle-store';
import { uploadPartnerSource, PartnerSourceTooLargeError } from './source-upload';

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

const TEST_PARTNER_ID = '550e8400-e29b-41d4-a716-446655440002';

test('KL2-W1: subir bytes → objeto en _fuentes/ con sha256 correcto del binario', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  const binary = Buffer.from('contenido de prueba %PDF-1.4 binario\x00\xff', 'binary');
  const expectedSha256 = createHash('sha256').update(binary).digest('hex');

  const result = await uploadPartnerSource(
    { partner_id: TEST_PARTNER_ID, filename: 'contrato.pdf', content_base64: binary.toString('base64') },
    store
  );

  assert.equal(result.sha256, expectedSha256, 'sha256 calculado sobre el binario real');
  assert.equal(result.gcs_object, `_fuentes/${expectedSha256}.pdf`, 'objeto bajo _fuentes/ con extensión preservada');
  assert.equal(result.created, true, 'primera subida: created=true');

  const stored = storage.versions.get(result.gcs_object);
  assert.ok(stored && stored.length === 1, 'el objeto se escribió exactamente una vez');
  assert.equal(stored![0].content, binary.toString('base64'), 'el contenido guardado es el base64 recibido tal cual');

  const log = storage.versions.get('log.md');
  assert.ok(log && log.length > 0, 'log.md registró la escritura (hash-chain)');
  assert.ok(log![0].content.includes(result.gcs_object), 'la entrada de log referencia el path escrito');

  const chain = await store.verifyChain();
  assert.equal(chain.ok, true, 'la cadena de custodia sigue íntegra tras el escrito raw');
});

test('KL2-W1: mismo contenido 2ª vez → mismo sha256, created:false, cero escrituras nuevas', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  const content_base64 = Buffer.from('documento idéntico').toString('base64');

  const first = await uploadPartnerSource(
    { partner_id: TEST_PARTNER_ID, filename: 'notas.txt', content_base64 },
    store
  );
  const logAfterFirst = storage.versions.get('log.md')!.length;

  const second = await uploadPartnerSource(
    { partner_id: TEST_PARTNER_ID, filename: 'notas.txt', content_base64 },
    store
  );

  assert.equal(second.sha256, first.sha256, 'mismo contenido → mismo sha256');
  assert.equal(second.gcs_object, first.gcs_object, 'mismo contenido → mismo objeto');
  assert.equal(second.created, false, 'segunda subida idéntica: created=false (idempotente)');

  const objectVersions = storage.versions.get(first.gcs_object)!.length;
  assert.equal(objectVersions, 1, 'el objeto no se reescribió');

  const logAfterSecond = storage.versions.get('log.md')!.length;
  assert.equal(logAfterSecond, logAfterFirst, 'log.md no creció en la segunda subida (cero escrituras nuevas)');
});

test('KL2-W1: fuente > 20MB → PartnerSourceTooLargeError, cero escrituras', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 'a');

  await assert.rejects(
    uploadPartnerSource(
      { partner_id: TEST_PARTNER_ID, filename: 'grande.bin', content_base64: oversized.toString('base64') },
      store
    ),
    (error: any) => error instanceof PartnerSourceTooLargeError && error.code === 413
  );

  assert.equal(storage.versions.size, 0, 'cero escrituras cuando la fuente excede el límite');
});

test('KL2-W1: filename sin extensión → gcs_object sin extensión', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  const content_base64 = Buffer.from('sin extension').toString('base64');
  const result = await uploadPartnerSource(
    { partner_id: TEST_PARTNER_ID, filename: 'README', content_base64 },
    store
  );

  assert.equal(result.gcs_object, `_fuentes/${result.sha256}`, 'sin extensión, el objeto no tiene sufijo');
});
