import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, buildTargetPath, resolveCollision } from './hocflit-router';

test("slugify('Objeciones de Precio — Sector Salud') === 'objeciones-de-precio-sector-salud'", () => {
  assert.equal(slugify('Objeciones de Precio — Sector Salud'), 'objeciones-de-precio-sector-salud');
});

test('slugify quita acentos y colapsa separadores', () => {
  assert.equal(slugify('  Política de Vacaciones  '), 'politica-de-vacaciones');
  assert.equal(slugify('A---B__C  D'), 'a-b-c-d');
});

test('slugify trunca a 60 caracteres', () => {
  const longTitle = 'a'.repeat(100);
  const slug = slugify(longTitle);
  assert.ok(slug.length <= 60);
});

test('buildTargetPath con tags[0] válido devuelve sistema/slug.md', () => {
  const path = buildTargetPath({ tags: ['c-comercial', 'precio'] }, 'Objeciones de Precio');
  assert.equal(path, 'c-comercial/objeciones-de-precio.md');
});

test('buildTargetPath con tags[0] inválido lanza throw', () => {
  assert.throws(() => buildTargetPath({ tags: ['no-es-un-sistema'] }, 'Titulo'));
});

test('resolveCollision sin títulos existentes conserva el path', async () => {
  const result = await resolveCollision('c-comercial/objeciones-precio.md', [], 'Objeciones de precio');
  assert.equal(result, 'c-comercial/objeciones-precio.md');
});

test('resolveCollision con título existente muy similar (>50% trigramas) conserva el path (mismo concepto)', async () => {
  const result = await resolveCollision(
    'c-comercial/objeciones-precio.md',
    ['Objeciones de precio sector salud'],
    'Objeciones de precio sector salud (actualizado)'
  );
  assert.equal(result, 'c-comercial/objeciones-precio.md');
});

test('resolveCollision con título existente distinto (<=50% trigramas) agrega sufijo -2', async () => {
  const result = await resolveCollision(
    'c-comercial/proceso-onboarding.md',
    ['Política de vacaciones anuales'],
    'Proceso de onboarding comercial'
  );
  assert.equal(result, 'c-comercial/proceso-onboarding-2.md');
});
