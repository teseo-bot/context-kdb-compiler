/**
 * Test de RLS (Row Level Security) para aislamiento multitenant
 *
 * Ejecuta las migraciones 001→004 en orden contra una BD Postgres,
 * luego verifica que RLS aisla correctamente las filas por tenant_id.
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
import { execSync } from 'child_process';

// Configuración
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';
const MIGRATIONS_DIR = path.join(__dirname, '../migrations');
const TEST_RESULTS: Array<{ name: string; passed: boolean; error?: string }> = [];

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
  console.log('\n=== Ejecutando migraciones 001→004 ===\n');

  const migrations = ['001_init.sql', '002_add_tenant_id.sql', '003_okf_index.sql', '004_rls.sql'];

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

// Función para crear el rol app_user si no existe
async function ensureAppUser(pool: Pool): Promise<void> {
  try {
    // Verificar si el rol existe
    const roleExists = await executeSql(pool, `
      SELECT 1 FROM pg_roles WHERE rolname = 'app_user'
    `);

    if (roleExists.length === 0) {
      console.log('Creando rol app_user...');
      await executeSql(pool, `
        CREATE USER app_user WITH PASSWORD 'app_user' LOGIN;
      `);

      // Grant permisos en okf_concepts para verificación
      await executeSql(pool, `
        GRANT SELECT, INSERT, DELETE ON okf_concepts TO app_user;
        GRANT USAGE ON SCHEMA public TO app_user;
      `);
      console.log('✓ Rol app_user creado\n');
    } else {
      console.log('✓ Rol app_user ya existe\n');
    }
  } catch (err) {
    console.error('Error creando rol:', (err as Error).message);
    // Continuar de todos modos
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

    // Crear rol app_user
    await ensureAppUser(adminPool);

    // === INICIO DE PRUEBAS RLS ===
    console.log('\n=== Pruebas de RLS ===\n');

    // Test 1: Insertar fila como tenant t1 (con usuario admin, sin RLS)
    console.log('Test 1: Insertar concepto con tenant_id=t1 (como admin)...');
    try {
      await executeSql(adminPool, `SET app.tenant_id='t1'`);
      await executeSql(adminPool, `
        INSERT INTO okf_concepts (
          tenant_id, path, frontmatter, body_text, content_sha256, altitude, system_slug
        ) VALUES (
          't1',
          'c-comercial/test.md',
          '{}',
          'test',
          'abc',
          1,
          'c-comercial'
        )
      `);
      TEST_RESULTS.push({ name: 'Test 1: Insert as t1', passed: true });
      console.log('✓ Inserción completada\n');
    } catch (err) {
      TEST_RESULTS.push({ name: 'Test 1: Insert as t1', passed: false, error: (err as Error).message });
      console.error('✗ Error:', (err as Error).message, '\n');
    }

    // Crear pool con app_user para pruebas RLS
    const appUserUrl = DATABASE_URL.replace('postgres:postgres@', 'app_user:app_user@');
    appUserPool = new Pool({ connectionString: appUserUrl });

    // Test 2: Verificar RLS con tenant t2 (debe devolver 0)
    console.log('Test 2: SELECT como tenant t2 con rol app_user (esperado 0 filas)...');
    try {
      await executeSql(appUserPool, `SET app.tenant_id='t2'`);
      const result = await executeSql(appUserPool, `SELECT COUNT(*) as count FROM okf_concepts`);
      const count = parseInt(result[0].count, 10);
      if (count === 0) {
        TEST_RESULTS.push({ name: 'Test 2: RLS blocks t2', passed: true });
        console.log('✓ RLS correcto: t2 no ve filas de t1\n');
      } else {
        TEST_RESULTS.push({ name: 'Test 2: RLS blocks t2', passed: false, error: `Esperado 0, obtuve ${count}` });
        console.error(`✗ RLS FALLO: t2 vio ${count} filas (esperado 0)\n`);
      }
    } catch (err) {
      TEST_RESULTS.push({ name: 'Test 2: RLS blocks t2', passed: false, error: (err as Error).message });
      console.error('✗ Error:', (err as Error).message, '\n');
    }

    // Test 3: Verificar RLS sin setting (debe devolver 0)
    console.log('Test 3: SELECT sin app.tenant_id con rol app_user (esperado 0 filas)...');
    try {
      await executeSql(appUserPool, `RESET app.tenant_id`);
      const result = await executeSql(appUserPool, `SELECT COUNT(*) as count FROM okf_concepts`);
      const count = parseInt(result[0].count, 10);
      if (count === 0) {
        TEST_RESULTS.push({ name: 'Test 3: RLS blocks no-setting', passed: true });
        console.log('✓ RLS correcto: sin setting no se ve nada\n');
      } else {
        TEST_RESULTS.push({ name: 'Test 3: RLS blocks no-setting', passed: false, error: `Esperado 0, obtuve ${count}` });
        console.error(`✗ RLS FALLO: sin setting vio ${count} filas (esperado 0)\n`);
      }
    } catch (err) {
      TEST_RESULTS.push({ name: 'Test 3: RLS blocks no-setting', passed: false, error: (err as Error).message });
      console.error('✗ Error:', (err as Error).message, '\n');
    }

    // Test 4: Verificar que t1 sigue viendo su fila
    console.log('Test 4: SELECT como t1 con rol app_user (esperado 1 fila)...');
    try {
      await executeSql(appUserPool, `SET app.tenant_id='t1'`);
      const result = await executeSql(appUserPool, `SELECT COUNT(*) as count FROM okf_concepts`);
      const count = parseInt(result[0].count, 10);
      if (count === 1) {
        TEST_RESULTS.push({ name: 'Test 4: t1 sees own row', passed: true });
        console.log('✓ t1 ve su propia fila\n');
      } else {
        TEST_RESULTS.push({ name: 'Test 4: t1 sees own row', passed: false, error: `Esperado 1, obtuve ${count}` });
        console.error(`✗ FALLO: t1 vio ${count} filas (esperado 1)\n`);
      }
    } catch (err) {
      TEST_RESULTS.push({ name: 'Test 4: t1 sees own row', passed: false, error: (err as Error).message });
      console.error('✗ Error:', (err as Error).message, '\n');
    }

    // Limpieza (como admin)
    console.log('Limpieza: borrando fila de test...');
    try {
      await executeSql(adminPool, `SET app.tenant_id='t1'`);
      await executeSql(adminPool, `DELETE FROM okf_concepts WHERE tenant_id='t1' AND path='c-comercial/test.md'`);
      console.log('✓ Limpieza completada\n');
    } catch (err) {
      console.error('✗ Error en limpieza:', (err as Error).message);
    }

    // === PRUEBA DE IDEMPOTENCIA ===
    console.log('\n=== Prueba de idempotencia de migraciones ===\n');
    console.log('Ejecutando migraciones 001→004 nuevamente...');
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
  console.log('  Test de RLS y Migraciones — Cerebro Virtual OKF');
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
