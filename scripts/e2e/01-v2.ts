// Harness E2E K8 — Script A: onboarding del bundle + seed de candidatos + V2 (destilación L1).
// Corre contra Cold-Tier real (Postgres 5436) + Ollama real (qwen) + bundle en disco.
import { Pool } from 'pg';
import { createBundleWithStorage } from '../create-bundle';
import { BundleStore } from '../../src/infrastructure/bundle-store';
import { runV2 } from '../../src/ingestion/candidate-poller';
import { FsStorageBackend, OllamaLLM, NoopPiiLlm } from './fs-backend';
import { createHash } from 'crypto';

const TENANT = process.env.E2E_TENANT ?? 'e2e-piloto';
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR ?? `/tmp/kdb-e2e/${TENANT}`;
const COLD = process.env.COLD_TIER_URL ?? 'postgres://postgres:postgres@localhost:5436/postgres';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function seedColdTier(pool: Pool): Promise<void> {
  const doc = `POLÍTICA DE DESCUENTOS COMERCIALES 2026

El descuento máximo autorizado sin aprobación de dirección es 15%. Entre 15% y 25%
requiere firma del gerente comercial. Arriba de 25% requiere aprobación del CEO.
Los descuentos por volumen aplican a partir de 50 unidades. El sector salud tiene
una política especial: se permite hasta 20% sin escalamiento por su ciclo de compra largo.`;
  const docHash = sha256(doc);

  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT]);
    // limpieza previa (re-ejecutable)
    await client.query('DELETE FROM knowledge_candidates WHERE tenant_id = $1', [TENANT]);
    await client.query('DELETE FROM okf_provenance WHERE tenant_id = $1', [TENANT]);
    await client.query('DELETE FROM okf_edges WHERE tenant_id = $1', [TENANT]);
    await client.query('DELETE FROM okf_concepts WHERE tenant_id = $1', [TENANT]);
    await client.query('DELETE FROM okf_merge_proposals WHERE tenant_id = $1', [TENANT]);
    await client.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT]);

    // documento para el candidato document_ingested
    await client.query(
      `INSERT INTO documents (document_hash, content, metadata, tenant_id)
       VALUES ($1, $2, '{}'::jsonb, $3)`,
      [docHash, doc, TENANT]
    );

    // 3 candidatos: 2 conversaciones cerradas + 1 documento
    const conv1 = `Prospecto (sector salud): "El precio me parece alto comparado con la competencia."
Agente: "Entiendo. ¿Con quién nos compara?" Prospecto: "Con MedTech, que da 20% de entrada."
Agente: "Podemos igualar con volumen." Prospecto: "Necesito al menos 18% o no avanzo."
[Cerrada: won tras aprobar 18% con firma del gerente. Objeción central: precio de entrada.]`;

    const conv2 = `Prospecto (retail): "¿Su sistema se integra con mi ERP actual (SAP)?"
Agente: "Sí, vía conector nativo." Prospecto: "¿Y el soporte es en español?"
Agente: "Sí, 24/7." Prospecto: "Perfecto, pero necesito verlo funcionando con mis datos."
[Cerrada: lost. Punto de fricción: pidió POC con datos reales que no se ofreció a tiempo.]`;

    const rows = [
      { kind: 'conversation_closed', source_ref: 'conv:thread-001', summary: conv1 },
      { kind: 'conversation_closed', source_ref: 'conv:thread-002', summary: conv2 },
      { kind: 'document_ingested', source_ref: `doc:sha256:${docHash}`, summary: doc.slice(0, 500) },
    ];
    for (const r of rows) {
      await client.query(
        `INSERT INTO knowledge_candidates (tenant_id, kind, source_ref, payload_summary, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [TENANT, r.kind, r.source_ref, r.summary]
      );
    }
    console.log(`  seed: 1 documento + 3 candidatos (${rows.map((r) => r.kind).join(', ')})`);
  } finally {
    await client.query('RESET app.tenant_id').catch(() => {});
    client.release();
  }
}

async function main() {
  console.log(`\n=== E2E K8 · Script A (V2) · tenant=${TENANT} ===`);
  console.log(`  bundle: ${BUNDLE_DIR}`);
  const backend = new FsStorageBackend(BUNDLE_DIR);
  const pool = new Pool({ connectionString: COLD });

  // 1. Onboarding del bundle (esqueleto HOCFLIT en disco)
  const ob = await createBundleWithStorage(TENANT, backend);
  console.log(`  onboarding: ${ob.fileCount} objetos, hash-chain ${ob.verified ? 'OK' : 'ROTO'}`);

  // 2. Seed del Cold-Tier
  await seedColdTier(pool);

  // 3. V2: destilación L1 con qwen (Ollama)
  const store = new BundleStore({ tenantId: TENANT, storage: backend });
  const t0 = Date.now();
  const res = await runV2({
    tenantId: TENANT,
    pool,
    store,
    distillerLlm: new OllamaLLM(undefined, undefined, true), // jsonMode para V2
    piiLlm: new NoopPiiLlm(),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  V2 (${secs}s): drafted=${res.drafted} discarded=${res.discarded} errors=${res.errors}`);

  // 4. Verificación: drafts en disco + hash-chain
  const staged = (await backend.list('_staging/')).filter((o) => o.path.endsWith('.md'));
  console.log(`  drafts en _staging/: ${staged.length}`);
  for (const s of staged) console.log(`    - ${s.path}`);
  const chain = await store.verifyChain();
  console.log(`  hash-chain: ${chain.ok ? 'OK ✓' : `ROTO en ${chain.brokenAt}`}`);

  await pool.end();
  if (res.errors > 0) {
    console.log(`  ⚠ ${res.errors} candidato(s) con error — revisar salida de qwen`);
  }
  console.log(`=== Script A completado ===\n`);
}

main().catch((e) => {
  console.error('E2E Script A falló:', e);
  process.exit(1);
});
