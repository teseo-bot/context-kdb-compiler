// Harness E2E K8 — Script C: indexación delta del bundle al Cold-Tier.
// Lee todos los conceptos + index.md del bundle en disco, calcula embeddings
// (mock determinista 768d — sin llave Gemini) y puebla okf_concepts/edges/provenance.
import { Pool } from 'pg';
import { BundleStore } from '../../src/infrastructure/bundle-store';
import { indexDelta } from '../../src/indexing/indexer';
import { MockEmbeddingsClient } from '../../src/infrastructure/embeddings.mock';
import { FsStorageBackend } from './fs-backend';

const TENANT = process.env.E2E_TENANT ?? 'e2e-piloto';
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR ?? `/tmp/kdb-e2e/${TENANT}`;
const COLD = process.env.COLD_TIER_URL ?? 'postgres://postgres:postgres@localhost:5436/postgres';

async function main() {
  console.log(`\n=== E2E K8 · Script C (index) · tenant=${TENANT} ===`);
  const backend = new FsStorageBackend(BUNDLE_DIR);
  const store = new BundleStore({ tenantId: TENANT, storage: backend });
  const pool = new Pool({ connectionString: COLD });
  const embeddings = new MockEmbeddingsClient();

  const res = await indexDelta(TENANT, { pool, store, embeddings });
  console.log(`  indexDelta: indexed=${res.indexed} skipped=${res.skipped}`);

  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT]);
    const concepts = await client.query(
      'SELECT path, system_slug, altitude FROM okf_concepts WHERE tenant_id=$1 ORDER BY path',
      [TENANT]
    );
    const edges = await client.query('SELECT count(*) FROM okf_edges WHERE tenant_id=$1', [TENANT]);
    const prov = await client.query('SELECT count(*) FROM okf_provenance WHERE tenant_id=$1', [TENANT]);
    console.log(`  okf_concepts: ${concepts.rowCount} filas`);
    for (const r of concepts.rows) console.log(`    - ${r.path} [${r.system_slug} a${r.altitude}]`);
    console.log(`  okf_edges: ${edges.rows[0].count} · okf_provenance: ${prov.rows[0].count}`);

    // Prueba de aislamiento RLS: como rol no-owner, otro tenant no ve estas filas.
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='e2e_app_user') THEN
        CREATE ROLE e2e_app_user LOGIN PASSWORD 'e2e';
      END IF;
      GRANT SELECT ON okf_concepts TO e2e_app_user;
    END $$;`);
  } finally {
    await client.query('RESET app.tenant_id').catch(() => {});
    client.release();
  }

  // Conexión no-owner para verificar RLS real
  const appPool = new Pool({ connectionString: COLD.replace('postgres:postgres@', 'e2e_app_user:e2e@') });
  const ac = await appPool.connect();
  try {
    await ac.query("SELECT set_config('app.tenant_id', $1, false)", ['otro-tenant']);
    const leak = await ac.query('SELECT count(*) FROM okf_concepts WHERE tenant_id=$1', [TENANT]);
    console.log(`  RLS cross-tenant (rol no-owner, tenant='otro-tenant'): ${leak.rows[0].count} filas visibles (esperado 0)`);
  } finally {
    await ac.query('RESET app.tenant_id').catch(() => {});
    ac.release();
    await appPool.end();
  }

  await pool.end();
  console.log(`=== Script C completado ===\n`);
}

main().catch((e) => {
  console.error('E2E Script C falló:', e);
  process.exit(1);
});
