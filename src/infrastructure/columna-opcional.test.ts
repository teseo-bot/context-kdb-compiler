// ADR-220 D-220.7 — la guarda que evita repetir la avería de la 013.
//
// Se prueba con un cliente falso porque lo que puede romperse no es el SQL sino la DECISIÓN:
// que una tabla sin la columna no la nombre en el INSERT, y que el catálogo se consulte sin
// caché. Recogido por el glob "src/**/*.test.ts".

import { test } from 'node:test';
import assert from 'node:assert';
import { columnaExiste } from './columna-opcional';

function clienteFalso(filas: number, registro: string[][] = []) {
  return {
    async query(sql: string, params: unknown[]) {
      registro.push([sql, JSON.stringify(params)]);
      return { rows: Array.from({ length: filas }, () => ({})) };
    },
  };
}

test('columna presente → true', async () => {
  assert.strictEqual(await columnaExiste(clienteFalso(1), 'documents', 'project_slugs'), true);
});

test('columna ausente → false, y NO lanza', async () => {
  // La instancia sin migrar tiene que seguir ingiriendo. Un throw aquí sería la 013 otra vez:
  // `/v1/ingest` roto por construcción hasta que alguien aplique la migración.
  assert.strictEqual(await columnaExiste(clienteFalso(0), 'documents', 'project_slugs'), false);
});

test('consulta pg_attribute y no information_schema', async () => {
  // `information_schema` filtra por privilegios del rol: puede decir «no existe» cuando lo que
  // pasa es que no la ves. Esa trampa ya costó una sesión en este programa.
  const registro: string[][] = [];
  await columnaExiste(clienteFalso(1, registro), 'documents', 'project_slugs');
  const sql = registro[0][0];
  assert.ok(sql.includes('pg_attribute'), 'debe consultar pg_attribute');
  assert.ok(!sql.includes('information_schema'), 'no debe consultar information_schema');
  assert.ok(sql.includes('attisdropped'), 'una columna borrada no cuenta como existente');
});

test('la tabla y la columna van como PARÁMETROS, no interpoladas', async () => {
  const registro: string[][] = [];
  await columnaExiste(clienteFalso(1, registro), 'documents', 'project_slugs');
  const [sql, params] = registro[0];
  assert.ok(!sql.includes('documents'), 'el nombre de la tabla no se interpola en el SQL');
  assert.deepStrictEqual(JSON.parse(params), ['documents', 'project_slugs']);
});

test('no cachea: dos llamadas consultan dos veces', async () => {
  // Una caché de proceso sobreviviría a la migración y dejaría al compiler creyendo durante
  // horas que la columna no existe, justo después de crearla.
  const registro: string[][] = [];
  const c = clienteFalso(1, registro);
  await columnaExiste(c, 'documents', 'project_slugs');
  await columnaExiste(c, 'documents', 'project_slugs');
  assert.strictEqual(registro.length, 2);
});
