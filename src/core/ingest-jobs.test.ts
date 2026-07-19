// Tests de integración de los tres métodos de `ingest_jobs` en CompilerEngine, contra el
// Postgres local (:5436, mismo que usa indexer.test.ts).
//
// Por qué existen: hasta el 2026-07-19 estos métodos NO estaban implementados — un
// `declare module` al final de src/server.ts se los prometía al type checker. `/v1/ingest`
// compilaba, desplegaba y moría en runtime con `engine.createIngestJob is not a function`.
// No había un solo test que tocara la ruta, así que nada lo delató.
//
// Estos tests fallan si alguien vuelve a dejar los métodos sin cuerpo real.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CompilerEngine } from './compiler-engine';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

let engine: CompilerEngine;
let pool: Pool;

function jobInput(tenantId: string, overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: tenantId,
    status: 'pending',
    requested_at: new Date('2026-07-19T12:00:00Z').toISOString(),
    documents_count: 2,
    workflow_id: 'wf-prueba',
    tags: ['comercial', 'manual'],
    cold_tier_eligible: true,
    document_metadata: [
      { document_id: 'doc-1', metadata: { hocflit: 'c-comercial' } },
      { document_id: 'doc-2' },
    ],
    ...overrides,
  };
}

before(async () => {
  engine = new CompilerEngine({ dbUrl: DATABASE_URL });
  pool = new Pool({ connectionString: DATABASE_URL });
});

after(async () => {
  await pool.query('DELETE FROM ingest_jobs WHERE tenant_id = ANY($1)', [[TENANT_A, TENANT_B]]);
  await pool.end();
  await engine.close();
});

test('createIngestJob persiste la fila y devuelve un id utilizable', async () => {
  const jobId = await engine.createIngestJob(jobInput(TENANT_A));

  assert.ok(jobId, 'debe devolver un id');
  assert.match(jobId, /^[0-9a-f-]{36}$/i, 'el id debe ser un uuid');

  // La verificación que importa: la fila EXISTE en la BD. Un método que devolviera un
  // uuid inventado sin escribir pasaría la aserción anterior y fallaría esta.
  const res = await pool.query('SELECT * FROM ingest_jobs WHERE id = $1', [jobId]);
  assert.equal(res.rows.length, 1, 'la fila debe existir en ingest_jobs');

  const row = res.rows[0];
  assert.equal(row.tenant_id, TENANT_A);
  assert.equal(row.status, 'pending');
  assert.equal(row.documents_count, 2);
  assert.equal(row.workflow_id, 'wf-prueba');
  assert.equal(row.cold_tier_eligible, true);
  assert.deepEqual(row.tags, ['comercial', 'manual']);
  assert.equal(row.document_metadata.length, 2);
  assert.equal(row.document_metadata[0].document_id, 'doc-1');
  assert.equal(row.completed_at, null, 'un job recién creado no está completado');
});

test('updateIngestJobStatus sella completed_at solo en estados terminales', async () => {
  const jobId = await engine.createIngestJob(jobInput(TENANT_A));

  await engine.updateIngestJobStatus(jobId, 'processing');
  let row = (await pool.query('SELECT status, completed_at FROM ingest_jobs WHERE id = $1', [jobId])).rows[0];
  assert.equal(row.status, 'processing');
  assert.equal(row.completed_at, null, 'un estado intermedio NO debe sellar completed_at');

  await engine.updateIngestJobStatus(jobId, 'completed_with_errors');
  row = (await pool.query('SELECT status, completed_at FROM ingest_jobs WHERE id = $1', [jobId])).rows[0];
  assert.equal(row.status, 'completed_with_errors');
  assert.ok(row.completed_at, 'un estado terminal debe sellar completed_at');
});

test('getIngestJobStatus devuelve el job y null cuando no existe', async () => {
  const jobId = await engine.createIngestJob(jobInput(TENANT_B, { status: 'completed' }));

  const found = await engine.getIngestJobStatus(jobId);
  assert.ok(found, 'debe encontrar el job recién creado');
  assert.equal(found!.id, jobId);
  assert.equal(found!.tenant_id, TENANT_B);
  assert.equal(found!.status, 'completed');
  assert.equal(found!.documents_count, 2);

  const missing = await engine.getIngestJobStatus(randomUUID());
  assert.equal(missing, null, 'un id inexistente devuelve null, no lanza');
});

test('el ciclo completo de /v1/ingest deja el job en estado terminal', async () => {
  // Espeja la secuencia real de la ruta: crear 'pending' -> compilar -> marcar terminal.
  const jobId = await engine.createIngestJob(jobInput(TENANT_B));
  await engine.updateIngestJobStatus(jobId, 'completed');

  const final = await engine.getIngestJobStatus(jobId);
  assert.equal(final!.status, 'completed');
  assert.ok(final!.completed_at, 'completed_at debe quedar sellado');
  assert.ok(final!.created_at, 'created_at lo pone el default de la migración 003');
});
