/**
 * PA7-W3: Tests dirigidos del agregador diario de citas de aliados (TRD §9, [INV-5.4])
 *
 * Postgres local :5436 (mismo patrón que license-sync.test.ts / publisher.test.ts) simula los
 * TRES planos: hotPool/coldPool/controlPool apuntan a la MISMA BD local. `kdb_partner_licenses`
 * ya existe (migración 007). `ephemeral_state`, `lead_summaries` y `partner_citation_stats` se
 * crean aquí con CREATE TABLE IF NOT EXISTS (shapes documentados en el header de
 * scripts/aggregate-partner-citations.ts / migración 011 del panel).
 *
 * DESVIACIÓN documentada: `partner_citation_stats` en la migración real del panel (011) tiene
 * `contract_id UUID NOT NULL REFERENCES partner_contracts(id) ON DELETE CASCADE` — `partner_contracts`
 * vive en el plano de CONTROL real (otro Postgres), que no existe en este Postgres local de
 * pruebas. Aquí se omite esa FK (mismas columnas y PK) porque los 3 planos son la MISMA BD en el
 * entorno de test.
 *
 * IDs de prueba propios, distintos de la semilla demo ('00000000-0000-4000-8000-00000000d0xx') y
 * de license-sync.test.ts ('...-0000000e570x'): '...-0000000e5710'..'5713'.
 *
 * Referencia de tiempo FIJA inyectada (`now: () => REFERENCE_NOW`) para que la ventana de
 * `sinceDays` sea determinista y no dependa del reloj real ni de límites de día.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { aggregateCitations } from '../../scripts/aggregate-partner-citations';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

const TEST_CONTRACT_ID = '00000000-0000-4000-8000-0000000e5710';
const TEST_TENANT_ID = 'test-tenant-pa7-w3';
const TEST_PARTNER_ID = '00000000-0000-4000-8000-0000000e5711';
const TEST_PACKAGE_ID = '00000000-0000-4000-8000-0000000e5712';
const TEST_PARTNER_SLUG = 'test-partner-pa7-w3';
const OTHER_TENANT_ID = 'test-tenant-pa7-w3-otro'; // slug sin licencia -> huérfana

// "hoy" fijo para todas las ventanas de sinceDays.
const REFERENCE_NOW = new Date('2026-07-10T12:00:00.000Z');
const referenceNowFn = () => REFERENCE_NOW;

let hotPool: Pool;
let coldPool: Pool;
let controlPool: Pool;

async function cleanHotTierRows(): Promise<void> {
  await hotPool.query('DELETE FROM ephemeral_state WHERE tenant_id LIKE $1', ['test-tenant-pa7-w3%']);
  await hotPool.query('DELETE FROM lead_summaries WHERE tenant_id LIKE $1', ['test-tenant-pa7-w3%']);
}

async function cleanStatsRows(): Promise<void> {
  await controlPool.query('DELETE FROM partner_citation_stats WHERE contract_id = $1', [TEST_CONTRACT_ID]);
}

before(async () => {
  hotPool = new Pool({ connectionString: DATABASE_URL });
  coldPool = new Pool({ connectionString: DATABASE_URL });
  controlPool = new Pool({ connectionString: DATABASE_URL });

  await hotPool.query(`
    CREATE TABLE IF NOT EXISTS ephemeral_state (
      thread_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await hotPool.query(`
    CREATE TABLE IF NOT EXISTS lead_summaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      kdb_citations JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await controlPool.query(`
    CREATE TABLE IF NOT EXISTS partner_citation_stats (
      contract_id UUID NOT NULL,
      day DATE NOT NULL,
      citations INT NOT NULL CHECK (citations >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (contract_id, day)
    )
  `);
  await controlPool.query('CREATE INDEX IF NOT EXISTS idx_pcs_day ON partner_citation_stats(day)');

  await cleanHotTierRows();
  await cleanStatsRows();
  await coldPool.query('DELETE FROM kdb_partner_licenses WHERE contract_id = $1', [TEST_CONTRACT_ID]);

  // Licencia de prueba propia (upsert directo permitido — no es el índice).
  await coldPool.query(
    `INSERT INTO kdb_partner_licenses
       (contract_id, tenant_id, partner_id, package_id, version, systems, altitude_max, modules,
        valid_from, valid_until, status, partner_slug, partner_legal_name, package_slug, package_title)
     VALUES ($1,$2,$3,$4,1,$5,3,$6,$7,$8,'active',$9,'Aliado de prueba PA7-W3','pkg-pa7-w3','Paquete de prueba PA7-W3')
     ON CONFLICT (contract_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id, partner_slug = EXCLUDED.partner_slug`,
    [
      TEST_CONTRACT_ID,
      TEST_TENANT_ID,
      TEST_PARTNER_ID,
      TEST_PACKAGE_ID,
      ['l-legal'],
      ['compliance'],
      '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      TEST_PARTNER_SLUG,
    ]
  );
});

after(async () => {
  await cleanHotTierRows();
  await cleanStatsRows();
  await coldPool.query('DELETE FROM kdb_partner_licenses WHERE contract_id = $1', [TEST_CONTRACT_ID]);
  await Promise.all([hotPool.end(), coldPool.end(), controlPool.end()]);
});

beforeEach(async () => {
  await cleanHotTierRows();
  await cleanStatsRows();
});

async function statsRows(): Promise<{ day: string; citations: number }[]> {
  const { rows } = await controlPool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, citations FROM partner_citation_stats
     WHERE contract_id = $1 ORDER BY day ASC`,
    [TEST_CONTRACT_ID]
  );
  return rows;
}

test('(1) citas en ephemeral_state en 2 días distintos -> 2 filas con conteos correctos', async () => {
  await hotPool.query(
    `INSERT INTO ephemeral_state (thread_id, tenant_id, state, updated_at) VALUES
       ('thread-1a', $1, $2::jsonb, $3),
       ('thread-1b', $1, $4::jsonb, $5)`,
    [
      TEST_TENANT_ID,
      JSON.stringify({ kdb_citations: [`@${TEST_PARTNER_SLUG}/l-legal/concept-a.md`, `@${TEST_PARTNER_SLUG}/l-legal/concept-b.md`] }),
      '2026-07-09T10:00:00.000Z',
      JSON.stringify({ kdb_citations: [`@${TEST_PARTNER_SLUG}/l-legal/concept-c.md`] }),
      '2026-07-08T10:00:00.000Z',
    ]
  );

  const result = await aggregateCitations({ hotPool, coldPool, controlPool, sinceDays: 7, now: referenceNowFn });

  assert.equal(result.rowsUpserted, 2, '2 filas (2 días distintos)');
  assert.equal(result.citationsCounted, 3, '3 citas en total');
  assert.ok(result.sourcesScanned.includes('ephemeral_state'));

  const rows = await statsRows();
  assert.deepEqual(rows, [
    { day: '2026-07-08', citations: 1 },
    { day: '2026-07-09', citations: 2 },
  ]);
});

test('(2) citas también en lead_summaries el mismo día -> se SUMAN al mismo (contract, day)', async () => {
  await hotPool.query(
    `INSERT INTO ephemeral_state (thread_id, tenant_id, state, updated_at) VALUES
       ('thread-2a', $1, $2::jsonb, $3)`,
    [TEST_TENANT_ID, JSON.stringify({ kdb_citations: [`@${TEST_PARTNER_SLUG}/l-legal/concept-a.md`] }), '2026-07-09T10:00:00.000Z']
  );
  await hotPool.query(
    `INSERT INTO lead_summaries (tenant_id, kdb_citations, created_at) VALUES ($1, $2::jsonb, $3)`,
    [
      TEST_TENANT_ID,
      JSON.stringify([`@${TEST_PARTNER_SLUG}/l-legal/concept-b.md`, `@${TEST_PARTNER_SLUG}/l-legal/concept-c.md`]),
      '2026-07-09T11:00:00.000Z',
    ]
  );

  const result = await aggregateCitations({ hotPool, coldPool, controlPool, sinceDays: 7, now: referenceNowFn });

  assert.equal(result.rowsUpserted, 1, '1 sola fila (mismo contract, mismo day)');
  assert.equal(result.citationsCounted, 3);
  assert.ok(result.sourcesScanned.includes('ephemeral_state'));
  assert.ok(result.sourcesScanned.includes('lead_summaries'));

  const rows = await statsRows();
  assert.deepEqual(rows, [{ day: '2026-07-09', citations: 3 }]);
});

test('(3) paths no-@ y state sin kdb_citations -> ignorados sin error', async () => {
  await hotPool.query(
    `INSERT INTO ephemeral_state (thread_id, tenant_id, state, updated_at) VALUES
       ('thread-3a', $1, $2::jsonb, $3),
       ('thread-3b', $1, $4::jsonb, $5),
       ('thread-3c', $1, $6::jsonb, $7)`,
    [
      TEST_TENANT_ID,
      JSON.stringify({ kdb_citations: ['no-es-un-path-certificado.md', `@${TEST_PARTNER_SLUG}/l-legal/concept-a.md`] }),
      '2026-07-09T10:00:00.000Z',
      JSON.stringify({ foo: 'bar' }), // sin kdb_citations
      '2026-07-09T10:00:00.000Z',
      JSON.stringify({ kdb_citations: 'no-es-array' }), // no es array
      '2026-07-09T10:00:00.000Z',
    ]
  );

  const result = await aggregateCitations({ hotPool, coldPool, controlPool, sinceDays: 7, now: referenceNowFn });

  assert.equal(result.rowsUpserted, 1);
  assert.equal(result.citationsCounted, 1, 'solo cuenta el path @ válido');

  const rows = await statsRows();
  assert.deepEqual(rows, [{ day: '2026-07-09', citations: 1 }]);
});

test('(4) cita con slug sin licencia -> huérfana, no crea fila', async () => {
  await hotPool.query(
    `INSERT INTO ephemeral_state (thread_id, tenant_id, state, updated_at) VALUES
       ('thread-4a', $1, $2::jsonb, $3)`,
    [OTHER_TENANT_ID, JSON.stringify({ kdb_citations: ['@slug-sin-licencia/l-legal/concept-x.md'] }), '2026-07-09T10:00:00.000Z']
  );

  const result = await aggregateCitations({ hotPool, coldPool, controlPool, sinceDays: 7, now: referenceNowFn });

  assert.equal(result.rowsUpserted, 0, 'no crea fila para el huérfano');
  assert.equal(result.citationsCounted, 1, 'sigue contándose en citationsCounted');

  const rows = await statsRows();
  assert.deepEqual(rows, []);
});

test('(5) re-corrida -> mismos conteos (idempotencia, no duplica ni acumula)', async () => {
  await hotPool.query(
    `INSERT INTO ephemeral_state (thread_id, tenant_id, state, updated_at) VALUES
       ('thread-5a', $1, $2::jsonb, $3)`,
    [TEST_TENANT_ID, JSON.stringify({ kdb_citations: [`@${TEST_PARTNER_SLUG}/l-legal/concept-a.md`] }), '2026-07-09T10:00:00.000Z']
  );

  const first = await aggregateCitations({ hotPool, coldPool, controlPool, sinceDays: 7, now: referenceNowFn });
  assert.equal(first.rowsUpserted, 1);
  const rowsAfterFirst = await statsRows();
  assert.deepEqual(rowsAfterFirst, [{ day: '2026-07-09', citations: 1 }]);

  const second = await aggregateCitations({ hotPool, coldPool, controlPool, sinceDays: 7, now: referenceNowFn });
  assert.equal(second.rowsUpserted, 1);
  const rowsAfterSecond = await statsRows();
  assert.deepEqual(rowsAfterSecond, [{ day: '2026-07-09', citations: 1 }], 'no duplica ni acumula (+=) en la re-corrida');
});

test('(6) fuera de ventana (hace 30 días, sinceDays=7) -> no cuenta', async () => {
  await hotPool.query(
    `INSERT INTO ephemeral_state (thread_id, tenant_id, state, updated_at) VALUES
       ('thread-6a', $1, $2::jsonb, $3)`,
    [TEST_TENANT_ID, JSON.stringify({ kdb_citations: [`@${TEST_PARTNER_SLUG}/l-legal/concept-a.md`] }), '2026-06-10T10:00:00.000Z']
  );

  const result = await aggregateCitations({ hotPool, coldPool, controlPool, sinceDays: 7, now: referenceNowFn });

  assert.equal(result.rowsUpserted, 0);
  assert.equal(result.citationsCounted, 0);

  const rows = await statsRows();
  assert.deepEqual(rows, []);
});
