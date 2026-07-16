/**
 * PA4-W3a: Tests dirigidos de license-sync.ts (lado compiler)
 *
 * Scope (tests pedidos por la WU):
 *  - upsertLicense con status='active' → 1 fila en kdb_partner_licenses con ese contract_id
 *    y los campos correctos (systems/modules como arrays, valid_until, status='active').
 *  - upsertLicense de nuevo con el MISMO contract_id y status='suspended' → sigue 1 fila (no
 *    duplica), status='suspended', synced_at avanzó.
 *  - deleteLicense → 0 filas para ese contract_id.
 *  - PartnerLicenseSyncInputSchema: action='upsert' sin license → falla; action='delete' con
 *    solo contract_id → pasa; status fuera del enum → falla.
 *
 * Postgres: local 5436 (mismo patrón que publisher.test.ts) — migración 007 ya aplicada ahí.
 * contract_id de prueba fijo que NO colisiona con la semilla demo
 * ('00000000-0000-4000-8000-00000000d003'): '00000000-0000-4000-8000-0000000e5701'.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { upsertLicense, deleteLicense, PartnerLicenseRow, PartnerLicenseSyncInputSchema } from './license-sync';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

const TEST_CONTRACT_ID = '00000000-0000-4000-8000-0000000e5701';
const TEST_TENANT_ID = 'test-tenant-pa4-w3a';
const TEST_PARTNER_ID = '00000000-0000-4000-8000-0000000e5702';
const TEST_PACKAGE_ID = '00000000-0000-4000-8000-0000000e5703';

let pool: Pool;

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query('DELETE FROM kdb_partner_licenses WHERE contract_id = $1', [TEST_CONTRACT_ID]);
});

after(async () => {
  await pool.query('DELETE FROM kdb_partner_licenses WHERE contract_id = $1', [TEST_CONTRACT_ID]);
  await pool.end();
});

function baseRow(overrides: Partial<PartnerLicenseRow> = {}): PartnerLicenseRow {
  return {
    contract_id: TEST_CONTRACT_ID,
    tenant_id: TEST_TENANT_ID,
    partner_id: TEST_PARTNER_ID,
    package_id: TEST_PACKAGE_ID,
    version: 1,
    systems: ['l-legal', 'f-finanzas'],
    altitude_max: 3,
    modules: ['contratos', 'facturas'],
    valid_from: '2026-07-01T00:00:00.000Z',
    valid_until: '2027-07-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

test("upsertLicense con status='active' → 1 fila con los campos correctos", async () => {
  await upsertLicense(pool, baseRow());

  const rows = await pool.query('SELECT * FROM kdb_partner_licenses WHERE contract_id = $1', [TEST_CONTRACT_ID]);
  assert.equal(rows.rows.length, 1, '1 fila insertada');
  const row = rows.rows[0];
  assert.equal(row.tenant_id, TEST_TENANT_ID);
  assert.equal(row.partner_id, TEST_PARTNER_ID);
  assert.equal(row.package_id, TEST_PACKAGE_ID);
  assert.equal(row.version, 1);
  assert.deepEqual(row.systems, ['l-legal', 'f-finanzas']);
  assert.equal(row.altitude_max, 3);
  assert.deepEqual(row.modules, ['contratos', 'facturas']);
  assert.ok(row.valid_until instanceof Date);
  assert.equal(row.status, 'active');
});

test("upsertLicense de nuevo con el MISMO contract_id y status='suspended' → sigue 1 fila, no duplica, synced_at avanzó", async () => {
  const before = await pool.query('SELECT synced_at FROM kdb_partner_licenses WHERE contract_id = $1', [TEST_CONTRACT_ID]);
  const synced_at_before = before.rows[0].synced_at;

  // Pequeña espera para asegurar que now() produzca un timestamp estrictamente posterior.
  await new Promise((resolve) => setTimeout(resolve, 10));

  await upsertLicense(pool, baseRow({ status: 'suspended' }));

  const rows = await pool.query('SELECT * FROM kdb_partner_licenses WHERE contract_id = $1', [TEST_CONTRACT_ID]);
  assert.equal(rows.rows.length, 1, 'sigue 1 fila (no duplica)');
  assert.equal(rows.rows[0].status, 'suspended');
  assert.ok(
    new Date(rows.rows[0].synced_at).getTime() > new Date(synced_at_before).getTime(),
    'synced_at avanzó'
  );
});

test('deleteLicense → 0 filas para ese contract_id', async () => {
  await deleteLicense(pool, TEST_CONTRACT_ID);

  const rows = await pool.query('SELECT * FROM kdb_partner_licenses WHERE contract_id = $1', [TEST_CONTRACT_ID]);
  assert.equal(rows.rows.length, 0, '0 filas tras el delete');
});

test("PartnerLicenseSyncInputSchema: action='upsert' sin license → falla", () => {
  const result = PartnerLicenseSyncInputSchema.safeParse({
    action: 'upsert',
    contract_id: TEST_CONTRACT_ID,
  });
  assert.equal(result.success, false, 'debe fallar sin license');
});

test("PartnerLicenseSyncInputSchema: action='delete' con solo contract_id → pasa", () => {
  const result = PartnerLicenseSyncInputSchema.safeParse({
    action: 'delete',
    contract_id: TEST_CONTRACT_ID,
  });
  assert.equal(result.success, true, 'debe pasar con solo contract_id en delete');
});

test('PartnerLicenseSyncInputSchema: status fuera del enum → falla', () => {
  const result = PartnerLicenseSyncInputSchema.safeParse({
    action: 'upsert',
    contract_id: TEST_CONTRACT_ID,
    license: baseRow({ status: 'archived' as any }),
  });
  assert.equal(result.success, false, 'debe fallar con status fuera del enum');
});

test('PartnerLicenseSyncInputSchema: upsert con license completo y válido → pasa', () => {
  const result = PartnerLicenseSyncInputSchema.safeParse({
    action: 'upsert',
    contract_id: TEST_CONTRACT_ID,
    license: baseRow(),
  });
  assert.equal(result.success, true, 'debe pasar con license completo y válido');
});

test('PartnerLicenseSyncInputSchema: upsert con los 4 campos nuevos (partner_slug, partner_legal_name, package_slug, package_title) → pasa', () => {
  const result = PartnerLicenseSyncInputSchema.safeParse({
    action: 'upsert',
    contract_id: TEST_CONTRACT_ID,
    license: baseRow({
      partner_slug: 'partner-slug-test',
      partner_legal_name: 'Partner Legal Name Test',
      package_slug: 'package-slug-test',
      package_title: 'Package Title Test',
    }),
  });
  assert.equal(result.success, true, 'debe pasar con los 4 campos nuevos rellenos');
});

test('PartnerLicenseSyncInputSchema: upsert sin los 4 campos nuevos (son opcionales) → pasa', () => {
  const result = PartnerLicenseSyncInputSchema.safeParse({
    action: 'upsert',
    contract_id: TEST_CONTRACT_ID,
    license: baseRow(),
  });
  assert.equal(result.success, true, 'debe pasar sin los 4 campos nuevos (son opcionales)');
});
