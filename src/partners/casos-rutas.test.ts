/**
 * ADR-224 paso 3 — rutas `/internal/partner-caso*` sobre el `app` real de src/server.ts.
 *
 * Requiere NODE_ENV=test (como server.test.ts) y Postgres local 5436 con la 016 aplicada:
 * casos.test.ts la aplica en su `before`; aquí se aplica también para que el archivo corra solo.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { app } from '../server';
import { frontmatterValido, cuerpoValido, NOTA_VALIDA } from './__fixtures__/casos';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';
const M2M_API_KEY = 'test-m2m-key-adr224';
const ALIADO = '00000000-0000-4000-8000-0000000ca5c3';

let pool: Pool;

function post(path: string, body: unknown, apiKey: string | null = M2M_API_KEY) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

before(async () => {
  process.env.M2M_API_KEY = M2M_API_KEY;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(readFileSync(join(__dirname, '..', '..', 'migrations', '016_casos_exito.sql'), 'utf8'));
  await pool.query('DELETE FROM casos_exito WHERE partner_id = $1', [ALIADO]);
});

after(async () => {
  await pool.query('DELETE FROM casos_exito WHERE partner_id = $1', [ALIADO]);
  await pool.end();
});

test('sin x-api-key o con una incorrecta → 401 en las cinco rutas', async () => {
  for (const path of [
    '/internal/partner-casos-list',
    '/internal/partner-caso-get',
    '/internal/partner-caso-create',
    '/internal/partner-caso-save',
    '/internal/partner-caso-submit',
  ]) {
    assert.equal((await post(path, { partner_id: ALIADO }, null)).status, 401, path);
    assert.equal((await post(path, { partner_id: ALIADO }, 'otra')).status, 401, path);
  }
});

test('body inválido o ilegible → 422 sin tocar la base', async () => {
  assert.equal((await post('/internal/partner-casos-list', { partner_id: 'no-es-uuid' })).status, 422);
  const ilegible = await app.request('/internal/partner-caso-create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
    body: '{no es json',
  });
  assert.equal(ilegible.status, 422);
  const slugMalo = await post('/internal/partner-caso-create', {
    partner_id: ALIADO, slug: 'Con Mayúsculas', frontmatter: {}, cuerpo_md: '', nota_consultor_md: '',
  });
  assert.equal(slugMalo.status, 422);
});

test('crear → 201, repetir slug → 409, mandar incompleto → 422 con hallazgos, completo → en_revision', async () => {
  const creado = await post('/internal/partner-caso-create', {
    partner_id: ALIADO, slug: 'caso-rutas', frontmatter: { tipo: 'caso', idioma: 'es' }, cuerpo_md: '', nota_consultor_md: '',
  });
  assert.equal(creado.status, 201);
  const { caso } = (await creado.json()) as { caso: { id: string; estado: string } };
  assert.equal(caso.estado, 'borrador');

  const repetido = await post('/internal/partner-caso-create', {
    partner_id: ALIADO, slug: 'caso-rutas', frontmatter: {}, cuerpo_md: '', nota_consultor_md: '',
  });
  assert.equal(repetido.status, 409);

  const incompleto = await post('/internal/partner-caso-submit', { partner_id: ALIADO, caso_id: caso.id });
  assert.equal(incompleto.status, 422);
  const { hallazgos } = (await incompleto.json()) as { hallazgos: { campo: string }[] };
  assert.ok(hallazgos.some((h) => h.campo === 'cuerpo_md'));

  const guardado = await post('/internal/partner-caso-save', {
    partner_id: ALIADO, caso_id: caso.id, frontmatter: frontmatterValido(), cuerpo_md: cuerpoValido(), nota_consultor_md: NOTA_VALIDA,
  });
  assert.equal(guardado.status, 200);

  const enviado = await post('/internal/partner-caso-submit', { partner_id: ALIADO, caso_id: caso.id });
  assert.equal(enviado.status, 200);
  assert.equal(((await enviado.json()) as { caso: { estado: string } }).caso.estado, 'en_revision');

  const reeditar = await post('/internal/partner-caso-save', {
    partner_id: ALIADO, caso_id: caso.id, frontmatter: {}, cuerpo_md: '', nota_consultor_md: '',
  });
  assert.equal(reeditar.status, 409);
  assert.equal(((await reeditar.json()) as { estado: string }).estado, 'en_revision');

  const lista = await post('/internal/partner-casos-list', { partner_id: ALIADO });
  assert.equal(((await lista.json()) as { casos: unknown[] }).casos.length, 1);
});

test('caso de otro aliado → 404', async () => {
  const { rows } = await pool.query('SELECT id FROM casos_exito WHERE partner_id = $1', [ALIADO]);
  const otro = '00000000-0000-4000-8000-0000000ca5d4';
  assert.equal((await post('/internal/partner-caso-get', { partner_id: otro, caso_id: rows[0].id })).status, 404);
});
