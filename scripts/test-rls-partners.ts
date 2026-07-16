/**
 * Test de RLS (Row Level Security) para el índice Cold-Tier de aliados
 * (okf_partner_concepts, okf_partner_edges, kdb_partner_licenses — migración 007)
 *
 * Espeja la mecánica de scripts/test-rls.ts:
 * - Ejecuta las migraciones 001→007 en orden contra una BD Postgres (como admin).
 * - El seed se inserta con el rol de servicio (admin/postgres, superuser: exento de RLS).
 * - Los SELECT de verificación corren con el rol app_user (no-superuser: RLS aplica).
 * - Variables de sesión con SET app.tenant_id / SET app.partner_id (scope sesión).
 * - Limpieza final con DELETE como admin (los pools son conexiones distintas,
 *   por lo que un BEGIN/ROLLBACK no sería visible entre roles — mismo trade-off
 *   que test-rls.ts, que también hace seed comprometido + DELETE al final).
 *
 * Requiere:
 * - DATABASE_URL en env (default: postgres://postgres:postgres@localhost:5436/postgres)
 * - Postgres accesible (levanta docker compose si existe)
 * - `pg` como dependencia (already installed)
 *
 * Exit code:
 * - 0 si todos los tests pasan
 * - 1 si algún test falla
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Configuración
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';
const MIGRATIONS_DIR = path.join(__dirname, '../migrations');
const TEST_RESULTS: Array<{ name: string; passed: boolean; error?: string }> = [];

// UUIDs fijos de los datos de prueba
const PARTNER_1 = 'a1111111-1111-1111-1111-111111111111';
const PARTNER_2 = 'a2222222-2222-2222-2222-222222222222';
const PKG_1 = 'b1111111-1111-1111-1111-111111111111';
const PKG_2 = 'b2222222-2222-2222-2222-222222222222';
const LICENSE_ACTIVE = 'c1111111-1111-1111-1111-111111111111';
const LICENSE_EXPIRED = 'c2222222-2222-2222-2222-222222222222';
const CONCEPT_IDS = [
  'd1111111-1111-1111-1111-111111111111',
  'd1111111-1111-1111-1111-111111111112',
  'd1111111-1111-1111-1111-111111111113',
  'd2222222-2222-2222-2222-222222222222',
];

// Helper para ejecutar SQL
async function executeSql(pool: Pool, sql: string, params?: any[]): Promise<any> {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

// Helper para leer un archivo de migración
function readMigration(filename: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf-8');
}

// Función para ejecutar migraciones en orden
async function runMigrations(pool: Pool): Promise<void> {
  console.log('\n=== Ejecutando migraciones 001→007 ===\n');

  const migrations = [
    '001_init.sql',
    '002_add_tenant_id.sql',
    '003_okf_index.sql',
    '004_rls.sql',
    '005_candidates_unique.sql',
    '006_candidates_metadata.sql',
    '007_partner_index.sql',
  ];

  for (const migrationFile of migrations) {
    try {
      const sql = readMigration(migrationFile);
      console.log(`Ejecutando ${migrationFile}...`);
      await executeSql(pool, sql);
      console.log(`✓ ${migrationFile} completada\n`);
    } catch (err) {
      console.error(`✗ Error en ${migrationFile}:`, (err as Error).message);
      throw err;
    }
  }
}

// Función para crear el rol app_user si no existe (mismo patrón que test-rls.ts)
async function ensureAppUser(pool: Pool): Promise<void> {
  try {
    const roleExists = await executeSql(pool, `
      SELECT 1 FROM pg_roles WHERE rolname = 'app_user'
    `);

    if (roleExists.length === 0) {
      console.log('Creando rol app_user...');
      await executeSql(pool, `
        CREATE USER app_user WITH PASSWORD 'app_user' LOGIN;
      `);
      console.log('✓ Rol app_user creado\n');
    } else {
      console.log('✓ Rol app_user ya existe\n');
    }

    // Grants sobre las tablas de aliados (SELECT en licenses es necesario también
    // porque la política licensed_tenant_read la referencia en su subquery)
    await executeSql(pool, `
      GRANT USAGE ON SCHEMA public TO app_user;
      GRANT SELECT ON okf_partner_concepts TO app_user;
      GRANT SELECT ON okf_partner_edges TO app_user;
      GRANT SELECT ON kdb_partner_licenses TO app_user;
    `);
    console.log('✓ Grants de aliados aplicados a app_user\n');
  } catch (err) {
    console.error('Error creando rol:', (err as Error).message);
    // Continuar de todos modos
  }
}

// Borrado de datos de prueba (como admin, exento de RLS)
async function deleteSeedData(pool: Pool): Promise<void> {
  await executeSql(pool, `
    DELETE FROM okf_partner_concepts WHERE id = ANY($1::uuid[]);
  `, [CONCEPT_IDS]);
  await executeSql(pool, `
    DELETE FROM kdb_partner_licenses WHERE contract_id = ANY($1::uuid[]);
  `, [[LICENSE_ACTIVE, LICENSE_EXPIRED]]);
}

// Seed con el rol de servicio (admin)
async function seedData(pool: Pool): Promise<void> {
  // Conceptos: 3 de partner 1 (finanzas alt2, comercial alt3, operaciones alt1)
  // + 1 de partner 2 (finanzas alt2)
  await executeSql(pool, `
    INSERT INTO okf_partner_concepts (
        id, partner_id, package_id, version, path, gcs_path, frontmatter, body_text,
        content_sha256, altitude, system_slug
    ) VALUES
        ('${CONCEPT_IDS[0]}'::uuid, '${PARTNER_1}'::uuid, '${PKG_1}'::uuid,
         1, 'doc1.md', 'gs://bucket/doc1.md', '{"title":"Doc 1"}', 'Content for doc 1',
         'hash1', 2, 'finanzas'),
        ('${CONCEPT_IDS[1]}'::uuid, '${PARTNER_1}'::uuid, '${PKG_1}'::uuid,
         1, 'doc2.md', 'gs://bucket/doc2.md', '{"title":"Doc 2"}', 'Content for doc 2',
         'hash2', 3, 'comercial'),
        ('${CONCEPT_IDS[2]}'::uuid, '${PARTNER_1}'::uuid, '${PKG_1}'::uuid,
         1, 'doc3.md', 'gs://bucket/doc3.md', '{"title":"Doc 3"}', 'Content for doc 3',
         'hash3', 1, 'operaciones'),
        ('${CONCEPT_IDS[3]}'::uuid, '${PARTNER_2}'::uuid, '${PKG_2}'::uuid,
         1, 'other.md', 'gs://bucket/other.md', '{"title":"Other"}', 'Content from partner 2',
         'hash_other', 2, 'finanzas');
  `);

  // Licencias:
  // - c1: t1, activa y vigente, systems=[finanzas,comercial], altitude_max=3
  // - c2: t3, status='active' pero valid_until en el pasado (caso 2: expira por
  //   tiempo, SIN tocar status)
  await executeSql(pool, `
    INSERT INTO kdb_partner_licenses (
        contract_id, tenant_id, partner_id, package_id, version,
        systems, altitude_max, modules, valid_from, valid_until, status
    ) VALUES
        ('${LICENSE_ACTIVE}'::uuid, 't1', '${PARTNER_1}'::uuid, '${PKG_1}'::uuid, 1,
         ARRAY['finanzas','comercial'], 3, ARRAY['read','search'],
         NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', 'active'),
        ('${LICENSE_EXPIRED}'::uuid, 't3', '${PARTNER_1}'::uuid, '${PKG_1}'::uuid, 1,
         ARRAY['finanzas','comercial'], 3, ARRAY['read','search'],
         NOW() - INTERVAL '60 days', NOW() - INTERVAL '30 days', 'active');
  `);
}

// Helper de aserción de conteo
async function assertCount(
  pool: Pool,
  name: string,
  sql: string,
  expected: number,
  description: string
): Promise<void> {
  console.log(`${name}: ${description} (esperado ${expected})...`);
  try {
    const result = await executeSql(pool, sql);
    const count = parseInt(result[0].count, 10);
    if (count === expected) {
      TEST_RESULTS.push({ name, passed: true });
      console.log(`✓ ${name} PASS: ${count} filas\n`);
    } else {
      TEST_RESULTS.push({ name, passed: false, error: `Esperado ${expected}, obtuve ${count}` });
      console.error(`✗ ${name} FAIL: esperado ${expected}, obtuve ${count}\n`);
    }
  } catch (err) {
    TEST_RESULTS.push({ name, passed: false, error: (err as Error).message });
    console.error(`✗ ${name} Error:`, (err as Error).message, '\n');
  }
}

// Función principal de prueba
async function runTests(): Promise<void> {
  const adminPool = new Pool({ connectionString: DATABASE_URL });
  let appUserPool: Pool | null = null;

  try {
    // Conectar y ejecutar migraciones con el usuario admin
    console.log('Conectando a Postgres como admin...');
    await adminPool.query('SELECT 1');
    console.log('✓ Conexión exitosa\n');

    // Ejecutar migraciones
    await runMigrations(adminPool);

    // Crear rol app_user + grants
    await ensureAppUser(adminPool);

    // === SETUP: seed con el rol de servicio (admin) ===
    console.log('SETUP: Insertando datos de prueba (rol de servicio)...');
    await deleteSeedData(adminPool); // limpieza previa por si un run anterior falló
    await seedData(adminPool);
    console.log('✓ Datos de prueba insertados\n');

    // Pool con app_user para pruebas RLS (mismo truco que test-rls.ts);
    // max:1 para que los SET de sesión apliquen a la misma conexión de los SELECT
    const appUserUrl = DATABASE_URL.replace('postgres:postgres@', 'app_user:app_user@');
    appUserPool = new Pool({ connectionString: appUserUrl, max: 1 });

    console.log('\n=== Pruebas de RLS de aliados (rol app_user) ===\n');

    // === CASE 1: tenant t1 con licencia activa vigente ===
    await executeSql(appUserPool, `SET app.tenant_id='t1'`);
    await executeSql(appUserPool, `SET app.partner_id=''`);
    await assertCount(
      appUserPool,
      'Case 1',
      `SELECT COUNT(*) as count FROM okf_partner_concepts`,
      2,
      't1 con licencia activa ve doc1 (finanzas) y doc2 (comercial); doc3 (operaciones) fuera de systems'
    );

    // === CASE 2: licencia con valid_until en el pasado, status intacto ===
    await executeSql(appUserPool, `SET app.tenant_id='t3'`);
    await assertCount(
      appUserPool,
      'Case 2',
      `SELECT COUNT(*) as count FROM okf_partner_concepts`,
      0,
      't3 solo tiene licencia expirada por tiempo (status sigue active)'
    );

    // === CASE 3: tenant t2 sin licencia ===
    await executeSql(appUserPool, `SET app.tenant_id='t2'`);
    await assertCount(
      appUserPool,
      'Case 3',
      `SELECT COUNT(*) as count FROM okf_partner_concepts`,
      0,
      't2 sin licencia no ve nada'
    );

    // === CASE 4: partner dueño (portal) ve lo suyo y nada de otro partner ===
    await executeSql(appUserPool, `SET app.tenant_id=''`);
    await executeSql(appUserPool, `SET app.partner_id='${PARTNER_1}'`);
    await assertCount(
      appUserPool,
      'Case 4a',
      `SELECT COUNT(*) as count FROM okf_partner_concepts`,
      3,
      'partner 1 ve sus 3 conceptos (y solo los suyos)'
    );
    await assertCount(
      appUserPool,
      'Case 4b',
      `SELECT COUNT(*) as count FROM okf_partner_concepts WHERE partner_id='${PARTNER_2}'::uuid`,
      0,
      'partner 1 no ve conceptos de partner 2'
    );

    // === CASE 5: concepto con system_slug fuera de license.systems ===
    await executeSql(appUserPool, `SET app.tenant_id='t1'`);
    await executeSql(appUserPool, `SET app.partner_id=''`);
    await assertCount(
      appUserPool,
      'Case 5',
      `SELECT COUNT(*) as count FROM okf_partner_concepts WHERE system_slug='operaciones'`,
      0,
      'doc3 (operaciones) fuera de systems=[finanzas,comercial] de la licencia'
    );

    // === EXTRA: RLS de kdb_partner_licenses ===
    await executeSql(appUserPool, `SET app.tenant_id='t1'`);
    await assertCount(
      appUserPool,
      'Extra licencias t1',
      `SELECT COUNT(*) as count FROM kdb_partner_licenses`,
      1,
      't1 ve solo su licencia'
    );
    await executeSql(appUserPool, `SET app.tenant_id='t2'`);
    await assertCount(
      appUserPool,
      'Extra licencias t2',
      `SELECT COUNT(*) as count FROM kdb_partner_licenses`,
      0,
      't2 sin licencias no ve ninguna'
    );

    // Limpieza (como admin, igual que test-rls.ts)
    console.log('Limpieza: borrando datos de test (rol de servicio)...');
    try {
      await deleteSeedData(adminPool);
      console.log('✓ Limpieza completada\n');
    } catch (err) {
      console.error('✗ Error en limpieza:', (err as Error).message);
    }

    // === PRUEBA DE IDEMPOTENCIA ===
    console.log('\n=== Prueba de idempotencia de migraciones ===\n');
    console.log('Ejecutando migraciones 001→007 nuevamente...');
    try {
      await runMigrations(adminPool);
      TEST_RESULTS.push({ name: 'Idempotency: run 2x', passed: true });
      console.log('✓ Migraciones son idempotentes\n');
    } catch (err) {
      TEST_RESULTS.push({ name: 'Idempotency: run 2x', passed: false, error: (err as Error).message });
      console.error('✗ Error en idempotencia:', (err as Error).message, '\n');
    }

  } catch (err) {
    console.error('\nError fatal:', (err as Error).message);
    process.exit(1);
  } finally {
    if (appUserPool) {
      await appUserPool.end();
    }
    await adminPool.end();
  }
}

// Ejecutar y reportar
async function main(): Promise<void> {
  console.log('====================================================');
  console.log('  Test de RLS Aliados — Conocimiento Certificado');
  console.log('====================================================');
  console.log(`DATABASE_URL: ${DATABASE_URL}\n`);

  try {
    await runTests();
  } catch (err) {
    console.error('Error ejecutando tests:', (err as Error).message);
  }

  // Reportar resultados
  console.log('\n====================================================');
  console.log('  RESULTADOS');
  console.log('====================================================\n');

  const passed = TEST_RESULTS.filter(r => r.passed).length;
  const total = TEST_RESULTS.length;

  TEST_RESULTS.forEach(result => {
    const status = result.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${status} - ${result.name}`);
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  });

  console.log(`\n${passed}/${total} tests pasados\n`);

  if (passed === total) {
    console.log('====================================================');
    console.log('  ✓ TODOS LOS TESTS PASARON');
    console.log('====================================================\n');
    process.exit(0);
  } else {
    console.log('====================================================');
    console.log('  ✗ ALGUNOS TESTS FALLARON');
    console.log('====================================================\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
