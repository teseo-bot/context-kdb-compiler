/**
 * ADR-224 paso 3 — curaduría de casos (src/partners/casos-curaduria.ts) contra Postgres local 5436,
 * con las migraciones REALES 016 y 017 aplicadas en el `before`.
 *
 * Lo que importa probar: que publicar deja el caso exactamente como lo exige la 016 (versión
 * inmutable + cabeza con versión, embedding y curador), y que NADA queda a medias cuando falla el
 * embedding o el caso cambia durante la publicación.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { MockEmbeddingsClient } from '../infrastructure/embeddings.mock';
import { EmbeddingsClient } from '../infrastructure/embeddings';
import { crearCaso, enviarARevision, guardarBorrador, CasoConflictoError, CasoIncompletoError } from './casos';
import { devolverCaso, huellaDeContenido, listarEnRevision, obtenerParaCuraduria, publicarCaso } from './casos-curaduria';
import { frontmatterValido, cuerpoValido, NOTA_VALIDA } from './__fixtures__/casos';
import { app } from '../server';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';
const ALIADO = '00000000-0000-4000-8000-0000000c0a01';
const CURADOR = 'uid-curador-micontexto';
const CLAVE_CURADURIA = 'test-curaduria-adr224';
const CLAVE_ALIADO = 'test-m2m-aliado-adr224';

let pool: Pool;
const embeddings = new MockEmbeddingsClient();

async function limpiar() {
  // Las versiones no se borran como `kdb_compiler` (017); aquí el test conecta como `postgres`.
  await pool.query('UPDATE casos_exito SET version_publicada = NULL, estado = $2 WHERE partner_id = $1', [ALIADO, 'retirado']);
  await pool.query('DELETE FROM casos_exito_versiones v USING casos_exito c WHERE v.caso_id = c.id AND c.partner_id = $1', [ALIADO]);
  await pool.query('DELETE FROM casos_exito WHERE partner_id = $1', [ALIADO]);
}

async function casoEnRevision(slug: string): Promise<string> {
  const c = await crearCaso(pool, {
    partner_id: ALIADO,
    slug,
    frontmatter: frontmatterValido(),
    cuerpo_md: cuerpoValido(),
    nota_consultor_md: NOTA_VALIDA,
  });
  await enviarARevision(pool, ALIADO, c.id);
  return c.id;
}

before(async () => {
  process.env.M2M_API_KEY = CLAVE_ALIADO;
  pool = new Pool({ connectionString: DATABASE_URL });
  for (const m of ['016_casos_exito.sql', '017_casos_exito_versiones_revoke.sql']) {
    await pool.query(readFileSync(join(__dirname, '..', '..', 'migrations', m), 'utf8'));
  }
  await limpiar();
});

after(async () => {
  await limpiar();
  await pool.end();
});

test('huellaDeContenido: no depende del orden de las llaves y cambia con el contenido', () => {
  const a = { frontmatter: { b: 1, a: { d: 2, c: 3 } }, cuerpo_md: 'x', nota_consultor_md: 'y' };
  const b = { nota_consultor_md: 'y', cuerpo_md: 'x', frontmatter: { a: { c: 3, d: 2 }, b: 1 } };
  assert.equal(huellaDeContenido(a), huellaDeContenido(b));
  assert.match(huellaDeContenido(a), /^[a-f0-9]{64}$/);
  assert.notEqual(huellaDeContenido(a), huellaDeContenido({ ...a, cuerpo_md: 'x ' }));
});

test('devolver → el aliado corrige y reenvía → publicar: versión 1 inmutable y cabeza completa', async () => {
  const id = await casoEnRevision('curaduria-ciclo');
  assert.ok((await listarEnRevision(pool)).some((c) => c.id === id), 'el caso está en la cola');

  const devuelto = await devolverCaso(pool, { caso_id: id, curador_uid: CURADOR, motivo: 'Falta de dónde sale la cifra de 23 pedidos.' });
  assert.equal(devuelto.estado, 'borrador');
  assert.equal(devuelto.motivo_devolucion, 'Falta de dónde sale la cifra de 23 pedidos.');
  assert.equal(devuelto.revisado_por, CURADOR);
  assert.ok(!(await listarEnRevision(pool)).some((c) => c.id === id), 'devuelto sale de la cola');

  await guardarBorrador(pool, {
    partner_id: ALIADO,
    caso_id: id,
    frontmatter: frontmatterValido(),
    cuerpo_md: cuerpoValido().replace('Texto de la sección.', 'Según el reporte mensual del cliente.'),
    nota_consultor_md: NOTA_VALIDA,
  });
  const reenviado = await enviarARevision(pool, ALIADO, id);
  assert.equal(reenviado.motivo_devolucion, 'Falta de dónde sale la cifra de 23 pedidos.', 'el curador ve qué pidió');

  const publicado = await publicarCaso(pool, embeddings, { caso_id: id, curador_uid: CURADOR });
  assert.equal(publicado.estado, 'publicado');
  assert.equal(publicado.version_publicada, 1);
  assert.equal(publicado.motivo_devolucion, null);
  assert.equal(publicado.revisado_por, CURADOR);
  assert.equal(publicado.versiones.length, 1);
  assert.equal(publicado.versiones[0]?.publicado_por, CURADOR);
  assert.equal(publicado.versiones[0]?.content_sha256, huellaDeContenido(publicado));

  const { rows } = await pool.query(
    `SELECT vector_dims(embedding_dolor) AS dims FROM casos_exito WHERE id = $1`,
    [id],
  );
  assert.equal(rows[0].dims, 768);

  await assert.rejects(publicarCaso(pool, embeddings, { caso_id: id, curador_uid: CURADOR }), CasoConflictoError);
  await assert.rejects(
    devolverCaso(pool, { caso_id: id, curador_uid: CURADOR, motivo: 'No se devuelve un publicado.' }),
    CasoConflictoError,
  );
});

test('un caso en revisión que no cumple el contrato no se publica', async () => {
  // Entró en revisión por SQL (la nota cumple el CHECK) pero el encabezado está a medias.
  const { rows } = await pool.query(
    `INSERT INTO casos_exito (partner_id, slug, estado, frontmatter, cuerpo_md, nota_consultor_md)
     VALUES ($1, 'curaduria-incompleto', 'en_revision', '{"tipo":"caso"}', '', $2) RETURNING id`,
    [ALIADO, NOTA_VALIDA],
  );
  const err = await publicarCaso(pool, embeddings, { caso_id: rows[0].id, curador_uid: CURADOR }).catch((e) => e);
  assert.ok(err instanceof CasoIncompletoError);
  assert.equal((await obtenerParaCuraduria(pool, rows[0].id)).estado, 'en_revision');
});

test('si el embedding falla, nada cambia: ni versión ni estado', async () => {
  const id = await casoEnRevision('curaduria-embedding-falla');
  const roto: EmbeddingsClient = { embed: async () => Promise.reject(new Error('429 cuota agotada')) };
  await assert.rejects(publicarCaso(pool, roto, { caso_id: id, curador_uid: CURADOR }), /429/);
  const caso = await obtenerParaCuraduria(pool, id);
  assert.equal(caso.estado, 'en_revision');
  assert.equal(caso.versiones.length, 0);
});

test('si el caso cambia mientras se calcula el embedding, la publicación se aborta', async () => {
  const id = await casoEnRevision('curaduria-carrera');
  const conCarrera: EmbeddingsClient = {
    embed: async (textos) => {
      // Otro proceso toca el cuerpo justo en la llamada de red.
      await pool.query(`UPDATE casos_exito SET cuerpo_md = cuerpo_md || ' (editado)' WHERE id = $1`, [id]);
      return embeddings.embed(textos);
    },
  };
  await assert.rejects(publicarCaso(pool, conCarrera, { caso_id: id, curador_uid: CURADOR }), CasoConflictoError);
  const caso = await obtenerParaCuraduria(pool, id);
  assert.equal(caso.estado, 'en_revision');
  assert.equal(caso.versiones.length, 0);
});

// ---------- rutas ----------

function post(path: string, body: unknown, apiKey: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
}

test('rutas de curaduría: sin CURADURIA_M2M_API_KEY puesta fallan cerradas (500)', async () => {
  delete process.env.CURADURIA_M2M_API_KEY;
  const res = await post('/internal/curaduria-casos-list', {}, CLAVE_ALIADO);
  assert.equal(res.status, 500);
});

test('rutas de curaduría: la clave del portal de aliados NO publica (401); la de curaduría sí', async () => {
  process.env.CURADURIA_M2M_API_KEY = CLAVE_CURADURIA;
  const id = await casoEnRevision('curaduria-rutas');

  const conClaveDelPortal = await post('/internal/curaduria-caso-publicar', { caso_id: id, curador_uid: CURADOR }, CLAVE_ALIADO);
  assert.equal(conClaveDelPortal.status, 401);

  const motivoCorto = await post('/internal/curaduria-caso-devolver', { caso_id: id, curador_uid: CURADOR, motivo: 'corto' }, CLAVE_CURADURIA);
  assert.equal(motivoCorto.status, 422);

  const cola = await post('/internal/curaduria-casos-list', {}, CLAVE_CURADURIA);
  assert.equal(cola.status, 200);
  assert.ok(((await cola.json()) as { casos: { id: string }[] }).casos.some((c) => c.id === id));

  const publicado = await post('/internal/curaduria-caso-publicar', { caso_id: id, curador_uid: CURADOR }, CLAVE_CURADURIA);
  assert.equal(publicado.status, 200);
  assert.equal(((await publicado.json()) as { caso: { estado: string } }).caso.estado, 'publicado');

  const otraVez = await post('/internal/curaduria-caso-publicar', { caso_id: id, curador_uid: CURADOR }, CLAVE_CURADURIA);
  assert.equal(otraVez.status, 409);
});
