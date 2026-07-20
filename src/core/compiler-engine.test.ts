// Test de integración de `CompilerEngine.compile` contra Postgres con el esquema UUID + RLS del
// Cold-Tier (migraciones 001/002/003/004). Es la primera cobertura de la función central: 187
// tests en el repo y ninguno la tocaba (el mismo hueco que dejó pasar el `declare module`).
//
// Corre como un rol NO-superusuario a propósito, para ejercitar la RLS FORCE: si `compile()`
// olvidara `SET app.tenant_id`, el INSERT violaría la política `USING (tenant_id = current_setting(
// 'app.tenant_id'))` y este test fallaría. Y cubre el cast `document_id::uuid[]` (bug #2): con el
// `::int[]` viejo, el INSERT de chunks revienta contra un `documents.id` que es UUID.
//
// Requiere Postgres en DATABASE_URL (por defecto :5436) con las migraciones aplicadas — mismo
// contrato que indexer.test.ts / server.test.ts. Sin Postgres, los tests se saltan (skip), no fallan.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EmbeddingsClient, EMBEDDING_DIM } from '../infrastructure/embeddings';
import { CompilerEngine } from './compiler-engine';

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';
const APP_ROLE = 'compiler_rls_test';
const APP_PASSWORD = 'compiler_rls_test_pw';
const TENANT = `cet-${process.pid}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Embeddings mock determinista de 768 dims (mismo patrón que indexer.test.ts): evita depender de
// GEMINI_DIRECT_KEY y produce vectores del ancho exacto de `chunks.embedding vector(768)`.
class Mock768 implements EmbeddingsClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => new Array(EMBEDDING_DIM).fill(0).map((_, i) => (Math.sin(t.length + i) + 1) / 2));
  }
}

const DOC = `# Política de préstamos DF
El monto máximo de préstamo para un cliente nuevo es de 50000 pesos.
La tasa aplicada es del 12 por ciento anual sobre saldos insolutos.
Los pagos son quincenales y la mora genera un recargo del 3 por ciento.
El plazo máximo autorizado es de 24 quincenas para clientes recurrentes.`;

let admin: Pool;
let engine: CompilerEngine | null = null;
let dbReady = false;

before(async () => {
  admin = new Pool({ connectionString: ADMIN_URL });
  try {
    // Verifica que el esquema del Cold-Tier esté aplicado (documents con RLS). Si no, skip.
    await admin.query('SELECT document_hash FROM documents WHERE false');

    await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON documents, chunks, ingest_jobs TO ${APP_ROLE}`);

    const u = new URL(ADMIN_URL);
    u.username = APP_ROLE;
    u.password = APP_PASSWORD;
    engine = new CompilerEngine({ dbUrl: u.toString(), embeddings: new Mock768() });
    dbReady = true;
  } catch (e) {
    console.error('[compiler-engine.test] Postgres/esquema no disponible; skip:', (e as Error).message);
    dbReady = false;
  }
});

after(async () => {
  if (engine) await engine.close().catch(() => {});
  if (admin) {
    try {
      await admin.query('DELETE FROM chunks WHERE tenant_id = $1', [TENANT]);
      await admin.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT]);
      await admin.query('DELETE FROM ingest_jobs WHERE tenant_id = $1', [TENANT]);
      await admin.query(`REVOKE ALL ON documents, chunks, ingest_jobs FROM ${APP_ROLE}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
    } catch {
      /* limpieza best-effort */
    }
    await admin.end();
  }
});

test('compile(): escribe documents + chunks con document_id UUID, bajo RLS FORCE (rol no-superusuario)', async (t) => {
  if (!dbReady || !engine) return t.skip('Postgres no disponible');

  const res = await engine.compile(DOC, { title: 'DF_PRESTAMO', tenantId: TENANT });

  // documentId es un UUID, no un int: con el tipo/cast viejos esto no existía o reventaba.
  assert.match(res.documentId, UUID_RE, `documentId debería ser UUID, fue ${res.documentId}`);
  assert.ok(res.chunkCount >= 1, `esperaba >=1 chunk, obtuve ${res.chunkCount}`);

  // Verificación por comportamiento contra la BD (como admin, que ve todos los tenants).
  const docRows = await admin.query(
    'SELECT id, document_hash, content, tenant_id FROM documents WHERE id = $1',
    [res.documentId]
  );
  assert.equal(docRows.rows.length, 1);
  assert.equal(docRows.rows[0].tenant_id, TENANT);
  assert.equal(docRows.rows[0].content, DOC);
  assert.equal(docRows.rows[0].document_hash, res.hash);

  const chunkRows = await admin.query(
    'SELECT document_id, embedding IS NOT NULL AS has_emb, tenant_id FROM chunks WHERE document_id = $1',
    [res.documentId]
  );
  assert.equal(chunkRows.rows.length, res.chunkCount);
  for (const r of chunkRows.rows) {
    assert.equal(r.document_id, res.documentId); // FK es el UUID del documento
    assert.equal(r.has_emb, true);
    assert.equal(r.tenant_id, TENANT);
  }
});

test('compile(): idempotente por (tenant, hash) — no duplica el documento', async (t) => {
  if (!dbReady || !engine) return t.skip('Postgres no disponible');

  const first = await engine.compile(DOC, { title: 'DF_PRESTAMO', tenantId: TENANT });
  const second = await engine.compile(DOC, { title: 'DF_PRESTAMO', tenantId: TENANT });
  assert.equal(second.documentId, first.documentId);

  const count = await admin.query(
    'SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1 AND document_hash = $2',
    [TENANT, first.hash]
  );
  assert.equal(count.rows[0].n, 1);
});
