#!/usr/bin/env npx tsx

/**
 * PA6-W1: E2E de revocación (gate de release del programa de Aliados)
 *
 * Script STANDALONE (no es un unit test) que demuestra en infra local el invariante central
 * del programa de Aliados: al TERMINAR el contrato del aliado demo "Bufete Demo & Asociados",
 * TODO acceso al conocimiento certificado `@bufete-demo/**` cae a 0 [INV-7.1], mientras que
 * los datos del aliado (okf_partner_concepts) NO se borran [INV-7.3] — la revocación ocurre
 * en el GATE de licencia (kdb_partner_licenses), nunca borrando el índice.
 *
 * Flujo:
 *   1. Limpieza previa (idempotencia) — mismo patrón que el `before()` de
 *      src/partners/seed-partner-demo.test.ts.
 *   2. Semilla por el pipeline REAL: `runSeed()` de scripts/seed-partner-demo.ts, con el MISMO
 *      wiring en memoria que usa src/partners/seed-partner-demo.test.ts (sin GCS/KMS/Gemini
 *      reales).
 *   3. Consulta ANTES con el gate de licencia (predicado IDÉNTICO al que usa el orquestador
 *      en context-kdb-orchestrator/src/tools/kdb.ts, CTE `partner_candidates` de
 *      COMBINED_SEARCH_SQL, líneas ~370-391): debe haber 12 conceptos visibles.
 *   4. Termina el contrato llamando a `deleteLicense(pool, DEMO_CONTRACT_ID)`
 *      (src/partners/license-sync.ts) — el mismo camino real que ejecuta el panel
 *      (action='delete' de /internal/partner-license-sync).
 *   5. Repite la consulta con gate: debe caer a 0 [INV-7.1].
 *   6. Verifica que okf_partner_concepts sigue teniendo 12 filas para el paquete demo
 *      [INV-7.3]: la caída de visibilidad fue el gate de licencia, no un borrado de datos.
 *
 * Uso:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5436/postgres npx tsx scripts/e2e-revocation.ts
 */

import { Pool } from 'pg';
import {
  runSeed,
  loadFixtures,
  makeFixtureDistillerLlm,
  makeCleanPiiLlm,
  DEMO_PARTNER_ID,
  DEMO_PACKAGE_ID,
  DEMO_TENANT_ID,
  DEMO_CONTRACT_ID,
} from './seed-partner-demo';
import {
  BundleStore,
  BundleStorageBackend,
  GenerationMismatchError,
  ReadResult,
  StoredObjectMeta,
} from '../src/infrastructure/bundle-store';
import { EmbeddingsClient, EMBEDDING_DIM } from '../src/infrastructure/embeddings';
import { signManifest } from '../src/partners/signer';
import { deleteLicense } from '../src/partners/license-sync';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

// ==================== GCS simulado (mismo patrón que seed-partner-demo.test.ts) ====================

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

function makeFakeSigner(): { signManifestFn: typeof signManifest } {
  const { privateKey } = generateKeyPairSync('ec', {
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

  return { signManifestFn };
}

// ==================== Lectura canónica con gate de licencia ====================
//
// Predicado FIEL al CTE `partner_candidates` de COMBINED_SEARCH_SQL en
// context-kdb-orchestrator/src/tools/kdb.ts (líneas ~370-391) — el mismo JOIN que enforcan
// kdb_search/kdb_browse/kdb_sources para servir conocimiento certificado de aliados. Se
// consulta directo contra Postgres (sin invocar el orquestador, otro repo) para que este
// script sea standalone dentro de context-kdb-compiler, pero el predicado es una copia
// literal del gate real.
const LICENSED_READ_GATE_SQL = `
  SELECT count(*)::int AS n
  FROM okf_partner_concepts pc
  JOIN kdb_partner_licenses l
    ON l.partner_id = pc.partner_id
   AND l.package_id = pc.package_id
   AND l.tenant_id = $1
   AND l.status = 'active'
   AND now() >= l.valid_from
   AND now() < l.valid_until
   AND pc.system_slug = ANY(l.systems)
   AND pc.altitude <= l.altitude_max
   AND $2::text = ANY(l.modules)
  WHERE pc.path LIKE '@bufete-demo/%'
`;

const AGENT_MODULE = 'compliance'; // mismo módulo que el seed asigna a la licencia (PA5-W2).

async function countLicensedVisible(pool: Pool): Promise<number> {
  const { rows } = await pool.query(LICENSED_READ_GATE_SQL, [DEMO_TENANT_ID, AGENT_MODULE]);
  return rows[0].n;
}

async function countRawConcepts(pool: Pool): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM okf_partner_concepts WHERE package_id = $1',
    [DEMO_PACKAGE_ID]
  );
  return rows[0].n;
}

// ==================== Runner ====================

interface StepResult {
  step: string;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const results: StepResult[] = [];
  let blocked = false;

  try {
    if (!process.env.KMS_PARTNER_KEYRING) {
      process.env.KMS_PARTNER_KEYRING =
        'projects/test/locations/us-central1/keyRings/kdb-partners-test';
    }

    // 1. Limpieza previa (idempotencia) — mismo patrón que seed-partner-demo.test.ts `before()`.
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query('DELETE FROM okf_partner_edges WHERE package_id = $1', [
        DEMO_PACKAGE_ID,
      ]);
      await cleanupClient.query('DELETE FROM okf_partner_concepts WHERE package_id = $1', [
        DEMO_PACKAGE_ID,
      ]);
      await cleanupClient.query('DELETE FROM kdb_partner_licenses WHERE contract_id = $1', [
        DEMO_CONTRACT_ID,
      ]);
    } finally {
      cleanupClient.release();
    }
    results.push({ step: '1. Limpieza previa', pass: true, detail: 'filas demo previas borradas' });

    // 2. Semilla por el pipeline real (bundle -> ingest -> curar -> publish -> contrato).
    const storage = new InMemoryStorageBackend();
    const store = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage });
    const embeddings = new MockEmbeddingsClient768();
    const { signManifestFn } = makeFakeSigner();
    const fixtures = loadFixtures();
    const distillerLlm = makeFixtureDistillerLlm(fixtures.concepts);
    const piiLlm = makeCleanPiiLlm();

    const seedResult = await runSeed({
      pool,
      store,
      storage,
      embeddings,
      signManifestFn,
      distillerLlm,
      piiLlm,
    });
    results.push({
      step: '2. Siembra (runSeed pipeline real)',
      pass: seedResult.conceptsPublished === 12,
      detail: `conceptsPublished=${seedResult.conceptsPublished}, contractId=${seedResult.contractId}`,
    });

    // 3. Consulta ANTES (gate de licencia): debe haber 12 conceptos visibles.
    const beforeCount = await countLicensedVisible(pool);
    const beforeOk = beforeCount === 12;
    results.push({
      step: '3. Consulta ANTES (gate de licencia, @bufete-demo/**)',
      pass: beforeOk,
      detail: `visible=${beforeCount} (esperado 12)`,
    });
    if (!beforeOk) blocked = true;

    // 4. Terminar contrato (revocación real) vía deleteLicense() — el camino real que ejecuta
    //    el panel al terminar el contrato (action='delete').
    await deleteLicense(pool, DEMO_CONTRACT_ID);
    results.push({
      step: '4. Terminar contrato (deleteLicense real)',
      pass: true,
      detail: `DELETE FROM kdb_partner_licenses WHERE contract_id=${DEMO_CONTRACT_ID}`,
    });

    // 5. Consulta DESPUÉS (gate de licencia): debe caer a 0 [INV-7.1].
    const afterCount = await countLicensedVisible(pool);
    const afterOk = afterCount === 0;
    results.push({
      step: '5. Consulta DESPUÉS (gate de licencia, @bufete-demo/**) [INV-7.1]',
      pass: afterOk,
      detail: `visible=${afterCount} (esperado 0)`,
    });
    if (!afterOk) blocked = true;

    // 6. Los datos NO se borraron [INV-7.3].
    const rawCount = await countRawConcepts(pool);
    const rawOk = rawCount === 12;
    results.push({
      step: '6. Datos NO borrados en okf_partner_concepts [INV-7.3]',
      pass: rawOk,
      detail: `okf_partner_concepts(package_id=demo)=${rawCount} (esperado 12)`,
    });
    if (!rawOk) blocked = true;

    // 7. Salida.
    console.log('\n==================== PA6-W1 E2E de revocación ====================');
    for (const r of results) {
      console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.step} — ${r.detail}`);
    }
    console.log('====================================================================\n');

    if (blocked) {
      console.error(
        'RELEASE BLOQUEADO: acceso residual a @bufete-demo/** tras terminar el contrato, ' +
          'o los datos del aliado no sobrevivieron a la revocación. Ver pasos FAIL arriba.'
      );
      process.exit(1);
    }

    console.log('PA6-W1 E2E revocación: PASS');
    process.exit(0);
  } catch (error) {
    console.error('[e2e-revocation] Error inesperado durante el E2E:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
