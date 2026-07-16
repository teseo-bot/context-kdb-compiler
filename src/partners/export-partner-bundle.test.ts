/**
 * PA6-W3b: Test dirigido del export de offboarding [INV-8.2].
 *
 * Siembra un bundle REAL (pipeline completo vía `runSeed`, mismo wiring en memoria que
 * `seed-partner-demo.test.ts`: InMemoryStorageBackend, MockEmbeddingsClient768, fake signer EC)
 * una sola vez en `before`, y clona el backend en memoria para cada test que necesita mutar
 * estado (recibo, corrupción) — así ninguna mutación de un test contamina a otro y el orden de
 * ejecución no importa.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import { Pool } from 'pg';
import {
  BundleStore,
  BundleStorageBackend,
  GenerationMismatchError,
  ReadResult,
  StoredObjectMeta,
} from '../infrastructure/bundle-store';
import { EmbeddingsClient, EMBEDDING_DIM } from '../infrastructure/embeddings';
import { signManifest } from './signer';
import { unpackTarGz } from './tar-pack';
import {
  runSeed,
  loadFixtures,
  makeFixtureDistillerLlm,
  makeCleanPiiLlm,
  DEMO_PARTNER_ID,
  DEMO_PARTNER_SLUG,
  DEMO_PACKAGE_ID,
  DEMO_PACKAGE_SLUG,
  DEMO_CONTRACT_ID,
} from '../../scripts/seed-partner-demo';
import { exportPartnerBundle } from '../../scripts/export-partner-bundle';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

// ==================== GCS simulado (mismo patrón que seed-partner-demo.test.ts), con clone() ====

class InMemoryStorageBackend implements BundleStorageBackend {
  versions = new Map<string, { content: string; generation: bigint }[]>();
  nextGeneration = 1n;

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

  /** Copia profunda de las versiones + contador de generación, para aislar mutaciones entre tests. */
  clone(): InMemoryStorageBackend {
    const copy = new InMemoryStorageBackend();
    for (const [path, list] of this.versions.entries()) {
      copy.versions.set(path, list.map((v) => ({ ...v })));
    }
    copy.nextGeneration = this.nextGeneration;
    return copy;
  }
}

class MockEmbeddingsClient768 implements EmbeddingsClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const seed = t.length;
      return new Array(EMBEDDING_DIM).fill(0).map((_, i) => (Math.sin(seed + i) + 1) / 2);
    });
  }
}

function makeFakeSigner(): { publicKey: string; signManifestFn: typeof signManifest } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const signManifestFn: typeof signManifest = async (canonicalJson: string) => {
    const digest = createHash('sha256').update(canonicalJson, 'utf-8').digest();
    const signer = createSign('sha256');
    signer.update(canonicalJson, 'utf-8');
    const signatureB64 = signer.sign(privateKey, 'base64');
    return {
      manifest_sha256: digest.toString('hex'),
      signature_b64: signatureB64,
      kms_key_version:
        'projects/test/locations/us-central1/keyRings/kdb-partners-test/cryptoKeys/partner-bufete-demo/cryptoKeyVersions/1',
    };
  };

  return { publicKey, signManifestFn };
}

/**
 * Corrompe el campo `prev:` de la línea `lineIndex` (0-indexed) de log.md, invalidando la
 * hash-chain a partir de esa línea. Simula un log.md alterado directamente en el backend
 * (bypass de `BundleStore.write`/`appendLog`), no un contenido de concepto alterado (eso NO
 * rompe la cadena — la cadena registra escrituras, no re-lee contenidos).
 */
function corruptPrevOnLine(logContent: string, lineIndex: number): string {
  const lines = logContent.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines[lineIndex]) {
    throw new Error(`corruptPrevOnLine: no existe línea ${lineIndex} en log.md (total=${lines.length})`);
  }
  lines[lineIndex] = lines[lineIndex].replace(/prev:(\S+)$/, (_match, prevVal: string) => {
    const flipped = prevVal[0] === '0' ? `f${prevVal.slice(1)}` : `0${prevVal.slice(1)}`;
    return `prev:${flipped}`;
  });
  return `${lines.join('\n')}\n`;
}

// ==================== now/nonce fijos para determinismo ====================

const FIXED_NOW = () => new Date('2026-07-10T12:00:00.000Z');
const FIXED_NONCE = () => 'deadbeefcafebabe';
const FAKE_SIGN_URL = async (objectPath: string) => `https://fake.example/${objectPath}`;

// ==================== Setup: siembra UNA vez, el resto de los tests clonan ====================

let pool: Pool;
let seededStorage: InMemoryStorageBackend;

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  if (!process.env.KMS_PARTNER_KEYRING) {
    process.env.KMS_PARTNER_KEYRING = 'projects/test/locations/us-central1/keyRings/kdb-partners-test';
  }

  // Idempotencia: limpia cualquier residuo del paquete/aliado/contrato demo de una corrida previa.
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM okf_partner_edges WHERE package_id = $1', [DEMO_PACKAGE_ID]);
    await client.query('DELETE FROM okf_partner_concepts WHERE package_id = $1', [DEMO_PACKAGE_ID]);
    await client.query('DELETE FROM kdb_partner_licenses WHERE contract_id = $1', [DEMO_CONTRACT_ID]);
  } finally {
    client.release();
  }

  seededStorage = new InMemoryStorageBackend();
  const seededStore = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: seededStorage });
  const embeddings = new MockEmbeddingsClient768();
  const { signManifestFn } = makeFakeSigner();

  const fixtures = loadFixtures();
  const distillerLlm = makeFixtureDistillerLlm(fixtures.concepts);
  const piiLlm = makeCleanPiiLlm();

  await runSeed({
    pool,
    store: seededStore,
    storage: seededStorage,
    embeddings,
    signManifestFn,
    distillerLlm,
    piiLlm,
  });
});

after(async () => {
  await pool.end();
});

// ==================== Tests ====================

test('exportPartnerBundle: export completo y fiel al estado del bundle', async () => {
  const cloneStorage = seededStorage.clone();
  const store = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: cloneStorage });

  const preExportObjects = await cloneStorage.list('');
  const preExportPaths = new Set(preExportObjects.map((o) => o.path));
  // Snapshot del CONTENIDO antes del export: el propio export apenda un recibo a log.md
  // (vía store.write), así que leer cloneStorage DESPUÉS del export ya no refleja fielmente lo
  // que se empaquetó (log.md habría cambiado). Comparamos contra este snapshot pre-export.
  const preExportContent = new Map<string, string>();
  for (const obj of preExportObjects) {
    const read = await cloneStorage.read(obj.path);
    preExportContent.set(obj.path, read!.content);
  }

  let capturedObjectPath: string | undefined;
  let capturedBuf: Buffer | undefined;

  await exportPartnerBundle({
    store,
    storage: cloneStorage,
    partnerId: DEMO_PARTNER_ID,
    partnerSlug: DEMO_PARTNER_SLUG,
    uploader: async (objectPath, data) => {
      capturedObjectPath = objectPath;
      capturedBuf = data;
    },
    signUrl: FAKE_SIGN_URL,
    now: FIXED_NOW,
    nonce: FIXED_NONCE,
  });

  assert.ok(capturedObjectPath, 'el uploader debe haber recibido un objectPath');
  assert.ok(capturedBuf, 'el uploader debe haber recibido el Buffer del tar.gz');

  const unpacked = unpackTarGz(capturedBuf!);
  const unpackedPaths = new Set(unpacked.map((e) => e.path));

  // (a) el set de paths del tar === el set de storage.list('') AL MOMENTO PREVIO al export
  // (sin _exports/, que se escribe DESPUÉS de empaquetar).
  assert.deepEqual(unpackedPaths, preExportPaths);
  assert.ok(![...unpackedPaths].some((p) => p.startsWith('_exports/')), 'el tar no debe incluir _exports/');

  // (b) contenido byte-a-byte (string UTF-8) igual para CADA archivo, contra el snapshot
  // pre-export (no contra cloneStorage post-export, que ya incluye el recibo apendado a log.md).
  for (const entry of unpacked) {
    const original = preExportContent.get(entry.path);
    assert.ok(original !== undefined, `el path ${entry.path} debe existir en el snapshot pre-export`);
    assert.equal(entry.content, original, `contenido idéntico para ${entry.path}`);
  }

  // (c) presencia de los paths clave.
  assert.ok(unpackedPaths.has('log.md'));
  assert.ok(unpackedPaths.has('index.md'));
  assert.ok([...unpackedPaths].some((p) => p.startsWith('_staging/')), 'debe haber al menos 1 path _staging/');
  assert.ok(unpackedPaths.has(`paquetes/${DEMO_PACKAGE_SLUG}/manifest.json`));

  const packageConceptPaths = [...unpackedPaths].filter(
    (p) =>
      p.startsWith(`paquetes/${DEMO_PACKAGE_SLUG}/`) &&
      p.endsWith('.md') &&
      p !== `paquetes/${DEMO_PACKAGE_SLUG}/index.md`
  );
  assert.equal(packageConceptPaths.length, 12, 'deben estar los 12 conceptos publicados');
});

test('la hash-chain verifica reconstruida DESDE el tar exportado', async () => {
  const cloneStorage = seededStorage.clone();
  const store = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: cloneStorage });

  let capturedBuf: Buffer | undefined;
  await exportPartnerBundle({
    store,
    storage: cloneStorage,
    partnerId: DEMO_PARTNER_ID,
    partnerSlug: DEMO_PARTNER_SLUG,
    uploader: async (_objectPath, data) => {
      capturedBuf = data;
    },
    signUrl: FAKE_SIGN_URL,
    now: FIXED_NOW,
    nonce: FIXED_NONCE,
  });

  const unpacked = unpackTarGz(capturedBuf!);
  const rebuiltStorage = new InMemoryStorageBackend();
  for (const entry of unpacked) {
    await rebuiltStorage.save(entry.path, entry.content);
  }
  const rebuiltStore = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: rebuiltStorage });
  const chain = await rebuiltStore.verifyChain();
  assert.equal(chain.ok, true, 'el aliado debe poder auditar la integridad de lo que recibió');
});

test('el recibo de export queda en _exports/ y encadena bien en el bundle original', async () => {
  const cloneStorage = seededStorage.clone();
  const store = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: cloneStorage });

  let capturedObjectPath: string | undefined;
  let capturedBuf: Buffer | undefined;

  const result = await exportPartnerBundle({
    store,
    storage: cloneStorage,
    partnerId: DEMO_PARTNER_ID,
    partnerSlug: DEMO_PARTNER_SLUG,
    uploader: async (objectPath, data) => {
      capturedObjectPath = objectPath;
      capturedBuf = data;
    },
    signUrl: FAKE_SIGN_URL,
    now: FIXED_NOW,
    nonce: FIXED_NONCE,
  });

  const exportObjs = await cloneStorage.list('_exports/');
  assert.equal(exportObjs.length, 1, 'exactamente 1 objeto en _exports/');

  const receiptRead = await cloneStorage.read(exportObjs[0].path);
  assert.ok(receiptRead, 'el recibo debe ser legible');
  const receipt = JSON.parse(receiptRead!.content);

  const expectedSha256 = createHash('sha256').update(capturedBuf!).digest('hex');
  assert.equal(receipt.sha256, expectedSha256);
  assert.equal(receipt.object_path, capturedObjectPath);
  assert.equal(result.sha256, expectedSha256);
  assert.equal(result.receiptPath, exportObjs[0].path);

  // El write del recibo encadenó bien: la cadena del bundle ORIGINAL sigue ok.
  const chain = await store.verifyChain();
  assert.equal(chain.ok, true);
});

test('exportPartnerBundle es determinista: mismo estado + mismo now/nonce → mismo sha256', async () => {
  const cloneA = seededStorage.clone();
  const cloneB = seededStorage.clone();
  const storeA = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: cloneA });
  const storeB = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: cloneB });

  const resultA = await exportPartnerBundle({
    store: storeA,
    storage: cloneA,
    partnerId: DEMO_PARTNER_ID,
    partnerSlug: DEMO_PARTNER_SLUG,
    uploader: async () => {},
    signUrl: FAKE_SIGN_URL,
    now: FIXED_NOW,
    nonce: FIXED_NONCE,
  });

  const resultB = await exportPartnerBundle({
    store: storeB,
    storage: cloneB,
    partnerId: DEMO_PARTNER_ID,
    partnerSlug: DEMO_PARTNER_SLUG,
    uploader: async () => {},
    signUrl: FAKE_SIGN_URL,
    now: FIXED_NOW,
    nonce: FIXED_NONCE,
  });

  assert.equal(resultA.sha256, resultB.sha256, 'el sha256 del tar.gz debe ser idéntico');
  assert.equal(resultA.objectPath, resultB.objectPath);
});

test('exportPartnerBundle rechaza (EXPORT BLOQUEADO) si la hash-chain de log.md está rota', async () => {
  const cloneStorage = seededStorage.clone();

  const logRead = await cloneStorage.read('log.md');
  assert.ok(logRead, 'log.md debe existir en el bundle sembrado');
  const lineCount = logRead!.content.split(/\r?\n/).filter((l) => l.length > 0).length;
  assert.ok(lineCount >= 3, 'el log sembrado debe tener al menos 3 líneas para este test');

  // Reescribe log.md DIRECTO vía backend.save() (bypass de BundleStore.write/appendLog),
  // alterando el campo prev: de la línea 3 (índice 2).
  const corrupted = corruptPrevOnLine(logRead!.content, 2);
  assert.notEqual(corrupted, logRead!.content, 'el contenido corrompido debe diferir del original');
  await cloneStorage.save('log.md', corrupted);

  const store = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: cloneStorage });

  await assert.rejects(
    () =>
      exportPartnerBundle({
        store,
        storage: cloneStorage,
        partnerId: DEMO_PARTNER_ID,
        partnerSlug: DEMO_PARTNER_SLUG,
        uploader: async () => {},
        signUrl: FAKE_SIGN_URL,
        now: FIXED_NOW,
        nonce: FIXED_NONCE,
      }),
    (err: Error) => err.message.includes('EXPORT BLOQUEADO')
  );
});

test('exportPartnerBundle rechaza si el bundle no tiene ningún objeto', async () => {
  const emptyStorage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage: emptyStorage });

  await assert.rejects(() =>
    exportPartnerBundle({
      store,
      storage: emptyStorage,
      partnerId: DEMO_PARTNER_ID,
      partnerSlug: DEMO_PARTNER_SLUG,
      uploader: async () => {},
      signUrl: FAKE_SIGN_URL,
      now: FIXED_NOW,
      nonce: FIXED_NONCE,
    })
  );
});
