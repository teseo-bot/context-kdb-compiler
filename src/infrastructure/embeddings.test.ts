import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiEmbeddingsClient,
  EmbeddingDimensionError,
  EMBEDDING_DIM,
} from './embeddings';
import { MockEmbeddingsClient } from './embeddings.mock';

const FAKE_VECTOR = new Array(EMBEDDING_DIM).fill(0.5);

test('MockEmbeddingsClient devuelve dim 768 y longitud correcta', async () => {
  const client = new MockEmbeddingsClient();
  const out = await client.embed(['hola', 'mundo', 'tres']);
  assert.equal(out.length, 3);
  for (const vec of out) assert.equal(vec.length, EMBEDDING_DIM);
});

test('MockEmbeddingsClient es determinista', async () => {
  const client = new MockEmbeddingsClient();
  const [a] = await client.embed(['mismo texto']);
  const [b] = await client.embed(['mismo texto']);
  assert.deepEqual(a, b);
});

test('GeminiEmbeddingsClient parte lotes de 100', async () => {
  const batchSizes: number[] = [];
  const client = new GeminiEmbeddingsClient({
    batchFn: async (texts) => {
      batchSizes.push(texts.length);
      return texts.map(() => FAKE_VECTOR);
    },
  });
  const texts = new Array(250).fill('t');
  const out = await client.embed(texts);
  assert.equal(out.length, 250);
  assert.deepEqual(batchSizes, [100, 100, 50]);
});

test('dimensión distinta de 768 lanza EmbeddingDimensionError', async () => {
  const client = new GeminiEmbeddingsClient({
    batchFn: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
  });
  await assert.rejects(client.embed(['x']), EmbeddingDimensionError);
});

test('conteo de salida distinto al de entrada lanza EmbeddingDimensionError', async () => {
  const client = new GeminiEmbeddingsClient({
    batchFn: async () => [FAKE_VECTOR], // devuelve 1 para 2 inputs
  });
  await assert.rejects(client.embed(['a', 'b']), EmbeddingDimensionError);
});

test('reintenta 3 veces en errores 429/5xx y luego propaga', async () => {
  let calls = 0;
  const err: any = new Error('rate limited');
  err.status = 429;
  const client = new GeminiEmbeddingsClient({
    retryDelaysMs: [1, 1, 1],
    batchFn: async () => {
      calls++;
      throw err;
    },
  });
  await assert.rejects(client.embed(['x']), /rate limited/);
  assert.equal(calls, 4); // intento inicial + 3 reintentos
});

test('errores no-retryables (4xx distintos de 429) se propagan de inmediato', async () => {
  let calls = 0;
  const err: any = new Error('invalid argument');
  err.status = 400;
  const client = new GeminiEmbeddingsClient({
    retryDelaysMs: [1, 1, 1],
    batchFn: async () => {
      calls++;
      throw err;
    },
  });
  await assert.rejects(client.embed(['x']), /invalid argument/);
  assert.equal(calls, 1);
});

test('se recupera si un reintento tiene éxito', async () => {
  let calls = 0;
  const err: any = new Error('server error');
  err.status = 503;
  const client = new GeminiEmbeddingsClient({
    retryDelaysMs: [1, 1, 1],
    batchFn: async (texts) => {
      calls++;
      if (calls < 3) throw err;
      return texts.map(() => FAKE_VECTOR);
    },
  });
  const out = await client.embed(['x']);
  assert.equal(out.length, 1);
  assert.equal(calls, 3);
});

test('embed([]) devuelve [] sin llamar al backend', async () => {
  let calls = 0;
  const client = new GeminiEmbeddingsClient({
    batchFn: async (texts) => {
      calls++;
      return texts.map(() => FAKE_VECTOR);
    },
  });
  assert.deepEqual(await client.embed([]), []);
  assert.equal(calls, 0);
});
