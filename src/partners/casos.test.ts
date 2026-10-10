/**
 * ADR-224 paso 3 — autoría de casos (src/partners/casos.ts) contra Postgres local 5436.
 *
 * El `before` aplica las migraciones REALES 016 y 017 (idempotentes), no un fixture: un SQL que no
 * coincida con lo que escribe este módulo tiene que romper aquí, no en producción.
 *
 * Lo que se prueba, además de la forma: el aislamiento por aliado. El compiler conecta como
 * `kdb_compiler` (BYPASSRLS), así que la única barrera entre dos aliados es el `WHERE partner_id`
 * de cada consulta. Si una se olvida, el aliado B lee o edita el caso del aliado A.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  CasoConflictoError,
  CasoIncompletoError,
  CasoNoEncontradoError,
  crearCaso,
  enviarARevision,
  guardarBorrador,
  listarCasos,
  obtenerCaso,
  revisarCasoCompleto,
} from './casos';
import { frontmatterValido, cuerpoValido, NOTA_VALIDA } from './__fixtures__/casos';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

// Aliados de prueba fijos que no colisionan con la semilla demo.
const ALIADO_A = '00000000-0000-4000-8000-0000000ca5a1';
const ALIADO_B = '00000000-0000-4000-8000-0000000ca5b2';

let pool: Pool;

function casoCompleto(partnerId: string, slug: string) {
  return { partner_id: partnerId, slug, frontmatter: frontmatterValido(), cuerpo_md: cuerpoValido(), nota_consultor_md: NOTA_VALIDA };
}

async function limpiar() {
  await pool.query('DELETE FROM casos_exito WHERE partner_id = ANY($1::uuid[])', [[ALIADO_A, ALIADO_B]]);
}

before(async () => {
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

// ---------- revisarCasoCompleto (pura) ----------

test('revisarCasoCompleto: un caso completo no tiene hallazgos', () => {
  assert.deepEqual(revisarCasoCompleto({ frontmatter: frontmatterValido(), cuerpo_md: cuerpoValido(), nota_consultor_md: NOTA_VALIDA }), []);
});

test('revisarCasoCompleto: nombra el campo de cada hallazgo del encabezado, del cuerpo y de la nota', () => {
  const fm = frontmatterValido();
  delete fm.dolor_canonico;
  const h = revisarCasoCompleto({
    frontmatter: fm,
    cuerpo_md: cuerpoValido().replace('## Dolor\n\nTexto de la sección.\n', '## Dolor\n\n'),
    nota_consultor_md: '   corta   ',
  });
  const campos = h.map((x) => `${x.campo}:${x.regla}`);
  assert.ok(campos.includes('frontmatter.dolor_canonico:encabezado-invalid_type'), campos.join(' | '));
  assert.ok(campos.includes('cuerpo_md:seccion-vacia'), campos.join(' | '));
  assert.ok(campos.includes('nota_consultor_md:nota-corta'), campos.join(' | '));
});

test('revisarCasoCompleto: 40 caracteres de espacios y saltos no son una nota', () => {
  const h = revisarCasoCompleto({ frontmatter: frontmatterValido(), cuerpo_md: cuerpoValido(), nota_consultor_md: ' \n'.repeat(30) });
  assert.deepEqual(h.map((x) => x.regla), ['nota-corta']);
});

// ---------- repositorio (Postgres) ----------

test('crearCaso → listarCasos → obtenerCaso: el borrador vuelve tal como se guardó', async () => {
  const creado = await crearCaso(pool, {
    partner_id: ALIADO_A,
    slug: 'transportista-whatsapp',
    frontmatter: { tipo: 'caso', idioma: 'es', titulo: 'A medias' },
    cuerpo_md: '',
    nota_consultor_md: '',
  });
  assert.equal(creado.estado, 'borrador');
  assert.equal(creado.titulo, 'A medias');
  assert.equal('revisado_por' in creado, false, 'el uid del curador no sale hacia el aliado');

  const lista = await listarCasos(pool, ALIADO_A);
  assert.equal(lista.length, 1);
  assert.equal(lista[0]?.slug, 'transportista-whatsapp');

  const leido = await obtenerCaso(pool, ALIADO_A, creado.id);
  assert.deepEqual(leido.frontmatter, { tipo: 'caso', idioma: 'es', titulo: 'A medias' });
});

test('crearCaso: el slug es único por aliado, no global', async () => {
  await assert.rejects(crearCaso(pool, casoCompleto(ALIADO_A, 'transportista-whatsapp')), CasoConflictoError);
  const deB = await crearCaso(pool, casoCompleto(ALIADO_B, 'transportista-whatsapp'));
  assert.equal(deB.slug, 'transportista-whatsapp');
});

test('aislamiento: el aliado B no lee, ni edita, ni manda a revisión un caso del aliado A', async () => {
  const [casoA] = await listarCasos(pool, ALIADO_A);
  assert.ok(casoA);
  assert.ok((await listarCasos(pool, ALIADO_B)).every((c) => c.id !== casoA.id));
  await assert.rejects(obtenerCaso(pool, ALIADO_B, casoA.id), CasoNoEncontradoError);
  await assert.rejects(
    guardarBorrador(pool, { partner_id: ALIADO_B, caso_id: casoA.id, frontmatter: {}, cuerpo_md: 'x', nota_consultor_md: '' }),
    CasoNoEncontradoError,
  );
  await assert.rejects(enviarARevision(pool, ALIADO_B, casoA.id), CasoNoEncontradoError);
  assert.equal((await obtenerCaso(pool, ALIADO_A, casoA.id)).titulo, 'A medias', 'el intento de B no tocó el caso');
});

test('enviarARevision: un borrador incompleto se rechaza con sus hallazgos y sigue en borrador', async () => {
  const [casoA] = await listarCasos(pool, ALIADO_A);
  const err = await enviarARevision(pool, ALIADO_A, casoA!.id).catch((e) => e);
  assert.ok(err instanceof CasoIncompletoError);
  assert.ok(err.hallazgos.some((h: { campo: string }) => h.campo === 'nota_consultor_md'));
  assert.equal((await obtenerCaso(pool, ALIADO_A, casoA!.id)).estado, 'borrador');
});

test('guardarBorrador + enviarARevision: el caso completo entra en revisión y deja de ser editable', async () => {
  const [casoA] = await listarCasos(pool, ALIADO_A);
  const guardado = await guardarBorrador(pool, {
    partner_id: ALIADO_A,
    caso_id: casoA!.id,
    frontmatter: frontmatterValido(),
    cuerpo_md: cuerpoValido(),
    nota_consultor_md: NOTA_VALIDA,
  });
  assert.ok(new Date(guardado.updated_at) >= new Date(casoA!.updated_at));

  const enviado = await enviarARevision(pool, ALIADO_A, casoA!.id);
  assert.equal(enviado.estado, 'en_revision');
  assert.equal(enviado.sector, 'logistica', 'la columna generada sale del encabezado');

  const err = await guardarBorrador(pool, {
    partner_id: ALIADO_A,
    caso_id: casoA!.id,
    frontmatter: {},
    cuerpo_md: '',
    nota_consultor_md: '',
  }).catch((e) => e);
  assert.ok(err instanceof CasoConflictoError);
  assert.equal(err.estado, 'en_revision');
  await assert.rejects(enviarARevision(pool, ALIADO_A, casoA!.id), CasoConflictoError);
  assert.equal((await obtenerCaso(pool, ALIADO_A, casoA!.id)).cuerpo_md, cuerpoValido(), 'el guardado rechazado no escribió');
});
