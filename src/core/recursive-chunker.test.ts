// Tests del troceador recursivo. El módulo no tenía ninguno —mismo hueco que `compile()`— y el
// agujero que se cierra aquí sólo se ve midiendo tamaños, no leyendo el código: el troceo estaba
// dimensionado en PALABRAS y un texto sin espacios cuenta como una sola, así que el documento
// entero salía como un chunk único.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from './recursive-chunker';

// Tiene que coincidir con MAX_CHUNK_CHARS del módulo. No se exporta a propósito (es un detalle
// interno), así que se repite aquí y este comentario es el recordatorio de moverlos juntos.
const TECHO = 8000;

const rep = (s: string, n: number) => Array(n).fill(s).join('');

const maxChars = (chunks: { text: string }[]) => Math.max(...chunks.map((c) => c.text.length));

test('un texto corto sigue volviendo como un solo chunk (el atajo no se rompió)', () => {
  const chunks = chunkText('Una frase corta y nada más.', { chunkSize: 300, chunkOverlap: 50 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
});

test('prosa larga: trocea y ningún chunk se acerca al techo', () => {
  const prosa = rep(
    'El sistema de rastreo satelital ubica la unidad en tiempo real. ' +
      'La cobertura cubre toda la republica mexicana. ' +
      'El reporte de posicion se emite cada treinta segundos. ',
    95
  );
  const chunks = chunkText(prosa, { chunkSize: 300, chunkOverlap: 50 });
  assert.ok(chunks.length > 5, `esperaba varios chunks, obtuve ${chunks.length}`);
  assert.ok(maxChars(chunks) <= TECHO, `algún chunk pasó del techo: ${maxChars(chunks)}`);
  // Y ninguno debería siquiera acercarse: 300 palabras ~2 KB. Si esto se dispara, algo dejó de
  // partir y el techo lo está tapando.
  assert.ok(maxChars(chunks) < 4000, `chunks sospechosamente grandes: ${maxChars(chunks)}`);
});

test('tabla markdown (casi sin puntuación de frase) también trocea', () => {
  const tabla =
    '| Folio | Cliente | Importe |\n|---|---|---|\n' +
    rep('| 5335 | KITE LOGISTICS | 45000 |\n', 420);
  const chunks = chunkText(tabla, { chunkSize: 300, chunkOverlap: 50 });
  assert.ok(chunks.length > 5, `esperaba varios chunks, obtuve ${chunks.length}`);
  assert.ok(maxChars(chunks) <= TECHO);
});

// 🔴 LA REGRESIÓN. Antes: 1 chunk de 19.5 KB, porque `countWords` = 1.
test('texto SIN espacios se trocea igual: es el agujero del dimensionado por palabras', () => {
  const sinEspacios = rep('dato', 5000); // ~19.5 KB, una sola «palabra»
  const chunks = chunkText(sinEspacios, { chunkSize: 300, chunkOverlap: 50 });

  assert.ok(chunks.length > 1, 'un texto de 19.5 KB no puede volver como un solo chunk');
  assert.ok(
    maxChars(chunks) <= TECHO,
    `ningún chunk puede pasar del techo de entrada del modelo; el mayor fue ${maxChars(chunks)}`
  );
  // No se pierde ni se duplica contenido al cortar en seco.
  assert.equal(chunks.map((c) => c.text).join('').length, sinEspacios.length);
});

test('texto CJK (no separa palabras con espacios) se trocea', () => {
  // El caso realista del mismo agujero: un documento en chino es una sola «palabra» para /\S+/g.
  const cjk = rep('卫星追踪系统可以实时定位车辆位置并每三十秒发送一次报告', 400);
  const chunks = chunkText(cjk, { chunkSize: 300, chunkOverlap: 50 });

  assert.ok(chunks.length > 1, `CJK debe trocearse; obtuve ${chunks.length} chunk(s)`);
  assert.ok(maxChars(chunks) <= TECHO, `el mayor fue ${maxChars(chunks)}`);
});

test('un base64 pegado entre palabras normales no arrastra el chunk por encima del techo', () => {
  const base64 = rep('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo', 400); // ~13.6 KB de un tirón
  const mezcla = `Adjunto el comprobante de la unidad. ${base64} Fin del comprobante.`;
  const chunks = chunkText(mezcla, { chunkSize: 300, chunkOverlap: 50 });

  assert.ok(maxChars(chunks) <= TECHO, `el mayor fue ${maxChars(chunks)}`);
});

test('los índices salen consecutivos desde 0 en todos los casos', () => {
  for (const texto of [rep('palabra ', 2000), rep('x', 20000), rep('Frase corta. ', 800)]) {
    const chunks = chunkText(texto, { chunkSize: 300, chunkOverlap: 50 });
    assert.deepEqual(
      chunks.map((c) => c.index),
      chunks.map((_, i) => i),
      'los index deben ser 0..n-1 sin huecos: `chunks.chunk_index` los usa como clave'
    );
  }
});
