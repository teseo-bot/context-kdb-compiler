/**
 * PA7-W1: Test dirigido de la semilla del aliado demo "Bufete Demo & Asociados".
 *
 * Ejecuta `runSeed` (scripts/seed-partner-demo.ts) contra infra local (GCS simulado en
 * memoria, Postgres local :5436, firma fake, embeddings mock, distiller/pii deterministas) y
 * verifica que los 12 conceptos sintéticos queden publicados en okf_partner_concepts PASANDO
 * POR EL PIPELINE REAL (bundle -> ingest -> curar -> publish -> contrato), sin NINGÚN insert
 * directo al índice desde este test [INV-9.1] (el `before` solo hace DELETE de limpieza).
 *
 * Wiring idéntico a src/partners/publisher.test.ts: InMemoryStorageBackend, MockEmbeddingsClient768,
 * fake signer (EC keypair + createSign), inyectados vía `signManifestFn` (mismo motivo documentado
 * en publisher.test.ts: un KmsClient fake no puede producir una firma verificable sin
 * reimplementar ECDSA a mano).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { Pool } from 'pg';
import {
  BundleStore,
  BundleStorageBackend,
  GenerationMismatchError,
  ReadResult,
  StoredObjectMeta,
} from '../infrastructure/bundle-store';
import { EmbeddingsClient, EMBEDDING_DIM } from '../infrastructure/embeddings';
import { verifyManifest, signManifest } from './signer';
import {
  runSeed,
  loadFixtures,
  makeFixtureDistillerLlm,
  makeCleanPiiLlm,
  DEMO_PARTNER_ID,
  DEMO_PACKAGE_ID,
  DEMO_TENANT_ID,
  DEMO_CONTRACT_ID,
} from '../../scripts/seed-partner-demo';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

// ==================== GCS simulado (mismo patrón que publisher.test.ts) ====================

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

class MockEmbeddingsClient768 implements EmbeddingsClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const seed = t.length;
      return new Array(EMBEDDING_DIM).fill(0).map((_, i) => (Math.sin(seed + i) + 1) / 2);
    });
  }
}

// ==================== Firma simulada (mismo patrón que publisher.test.ts) ====================

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

// ==================== Setup ====================

let pool: Pool;

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
});

after(async () => {
  await pool.end();
});

// ==================== Test ====================

test('PA7-W1: runSeed publica los 12 conceptos demo por el pipeline real (bundle->ingest->curar->publish->contrato)', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage });
  const embeddings = new MockEmbeddingsClient768();
  const { publicKey, signManifestFn } = makeFakeSigner();

  const fixtures = loadFixtures();
  assert.equal(fixtures.concepts.length, 12, 'el fixture debe declarar 12 conceptos');

  const distillerLlm = makeFixtureDistillerLlm(fixtures.concepts);
  const piiLlm = makeCleanPiiLlm();

  const result = await runSeed({
    pool,
    store,
    storage,
    embeddings,
    signManifestFn,
    distillerLlm,
    piiLlm,
  });

  assert.equal(result.conceptsPublished, 12, 'el manifest debe reportar 12 conceptos publicados');
  assert.equal(result.contractId, DEMO_CONTRACT_ID);

  // Aceptación 1: 12 filas en okf_partner_concepts para el aliado demo.
  const concepts = await pool.query(
    'SELECT path, system_slug, altitude, embedding IS NOT NULL AS has_embedding FROM okf_partner_concepts WHERE partner_id = $1',
    [DEMO_PARTNER_ID]
  );
  assert.equal(concepts.rows.length, 12, '12 filas en okf_partner_concepts para el partner demo');
  for (const row of concepts.rows) {
    assert.equal(row.system_slug, 'l-legal');
    assert.equal(row.has_embedding, true);
  }

  // Aceptación 2: al menos 4 aristas intra-paquete generadas por los cross-links del fixture.
  const edges = await pool.query('SELECT from_path, to_path FROM okf_partner_edges WHERE package_id = $1', [
    DEMO_PACKAGE_ID,
  ]);
  assert.ok(
    edges.rows.length >= 4,
    `se esperaban >=4 aristas intra-paquete, se obtuvieron ${edges.rows.length}`
  );

  // Aceptación 3: el manifest firmado verifica con la llave pública del signer fake.
  const manifestFile = await store.read(`paquetes/legal-esencial/manifest.json`);
  assert.ok(manifestFile, 'manifest.json escrito al bundle');
  const manifest = JSON.parse(manifestFile!.content);
  assert.equal(manifest.manifest_sha256, result.manifestSha256);
  const verification = verifyManifest(manifest, publicKey);
  assert.equal(verification, 'verified', 'el manifest firmado debe verificar');

  // Aceptación 4: 1 fila en kdb_partner_licenses con status='active' y valid_until ~ now+90d.
  const licenses = await pool.query(
    'SELECT status, tenant_id, modules, partner_slug, partner_legal_name, package_slug, package_title, valid_from, valid_until FROM kdb_partner_licenses WHERE contract_id = $1',
    [DEMO_CONTRACT_ID]
  );
  assert.equal(licenses.rows.length, 1, '1 fila en kdb_partner_licenses para el contrato demo');
  assert.equal(licenses.rows[0].status, 'active');
  assert.equal(licenses.rows[0].tenant_id, DEMO_TENANT_ID);
  // PA5-W2: módulo consumible (el agente 'compliance' consume el paquete legal) +
  // slugs/nombres de presentación y navegación para el browse `_aliados/` del orquestador.
  assert.deepEqual(licenses.rows[0].modules, ['compliance']);
  assert.equal(licenses.rows[0].partner_slug, 'bufete-demo');
  assert.equal(licenses.rows[0].partner_legal_name, 'Bufete Demo & Asociados');
  assert.equal(licenses.rows[0].package_slug, 'legal-esencial');
  assert.equal(licenses.rows[0].package_title, 'Legal Esencial');

  const validFrom = new Date(licenses.rows[0].valid_from).getTime();
  const validUntil = new Date(licenses.rows[0].valid_until).getTime();
  const expectedUntil = validFrom + 90 * 24 * 60 * 60 * 1000;
  assert.ok(
    Math.abs(validUntil - expectedUntil) < 5000,
    `valid_until debe ser ~90 días después de valid_from (delta=${validUntil - expectedUntil}ms)`
  );
});
