// K9-W1 (SPEC-K9 §2.5): distiller legacy debe soportar text/markdown y text/csv como texto
// plano UTF-8 (igual que text/plain), sin dependencias nuevas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentDistiller } from './distiller';

test('K9-W1: processBuffer con text/markdown devuelve el texto', async () => {
  const distiller = new DocumentDistiller();
  const markdown = '# Título\n\nContenido de prueba en markdown.';
  const result = await distiller.processBuffer(Buffer.from(markdown, 'utf-8'), 'text/markdown', 'nota.md');

  assert.match(result, /Contenido de prueba en markdown\./);
});

test('K9-W1: processBuffer con text/csv devuelve el texto', async () => {
  const distiller = new DocumentDistiller();
  const csv = 'nombre,valor\nfoo,1\nbar,2';
  const result = await distiller.processBuffer(Buffer.from(csv, 'utf-8'), 'text/csv', 'datos.csv');

  assert.match(result, /nombre,valor/);
  assert.match(result, /foo,1/);
});
