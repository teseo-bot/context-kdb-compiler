/**
 * PA7-W2: Tests dirigidos de `scripts/eval-partner-package.ts` (gate de eval de paquete).
 *
 * Postgres local :5436 (mismo patrón que license-sync.test.ts / aggregate-partner-citations.test.ts).
 * `before` aplica la migración 008 (ALTER TABLE ... ADD COLUMN IF NOT EXISTS, idempotente) por si
 * el Postgres local todavía no la tiene — mismo espíritu que "migración 007 ya aplicada" en
 * license-sync.test.ts, pero aquí no asumimos que 008 ya corrió.
 *
 * Stub LLM determinista: ANSWER_PROMPT siempre devuelve un texto fijo; JUDGE_PROMPT devuelve el
 * score embebido en la pregunta fixture vía un marcador `[s:NN]` (p.ej. "...¿algo? [s:95]" →
 * responde '95'). El stub distingue answer/judge por el marcador único de JUDGE_PROMPT
 * ("Formato exacto: un entero") que no aparece en ANSWER_PROMPT.
 *
 * IDs de prueba propios, sin colisión con la semilla demo ni con otros tests de PA7:
 * partner '...-0000000e5720', package '...-0000000e5721', otro package (mismo partner)
 * '...-0000000e5722', otro partner '...-0000000e5723'.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { evalPartnerPackage, JUDGE_PROMPT } from '../../scripts/eval-partner-package';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

const TEST_PARTNER_ID = '00000000-0000-4000-8000-0000000e5720';
const TEST_PACKAGE_ID = '00000000-0000-4000-8000-0000000e5721';
const OTHER_PACKAGE_ID = '00000000-0000-4000-8000-0000000e5722'; // mismo partner, otro paquete
const OTHER_PARTNER_ID = '00000000-0000-4000-8000-0000000e5723';
const OTHER_PARTNER_PACKAGE_ID = '00000000-0000-4000-8000-0000000e5724';

const TENANT = `partner:${TEST_PARTNER_ID}`;
const OTHER_TENANT = `partner:${OTHER_PARTNER_ID}`;

// Marcador único de JUDGE_PROMPT (ver comentario de archivo arriba) para distinguir la llamada
// de juicio de la llamada de respuesta, sin depender de contar invocaciones por orden.
const JUDGE_MARKER = 'Formato exacto: un entero';

let pool: Pool;

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });

  // Migración 008: idempotente, se aplica aquí por si el Postgres local aún no la tiene.
  await pool.query('ALTER TABLE okf_golden_questions ADD COLUMN IF NOT EXISTS package_id UUID');
  await pool.query('ALTER TABLE okf_eval_runs ADD COLUMN IF NOT EXISTS package_id UUID');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS okf_golden_questions_package_idx ON okf_golden_questions(package_id) WHERE package_id IS NOT NULL'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS okf_eval_runs_package_idx ON okf_eval_runs(package_id, run_at DESC) WHERE package_id IS NOT NULL'
  );

  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

beforeEach(async () => {
  await cleanup();
});

async function cleanup(): Promise<void> {
  await pool.query('DELETE FROM okf_eval_runs WHERE tenant_id IN ($1, $2)', [TENANT, OTHER_TENANT]);
  await pool.query('DELETE FROM okf_golden_questions WHERE tenant_id IN ($1, $2)', [TENANT, OTHER_TENANT]);
}

function makeStubLlm(): { generate: (prompt: string) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    generate: async (prompt: string) => {
      calls.push(prompt);
      if (prompt.includes(JUDGE_MARKER)) {
        const match = prompt.match(/\[s:(\d+)\]/);
        return match ? match[1] : '0';
      }
      return 'Respuesta fija de prueba basada en el contexto provisto.';
    },
  };
}

async function seedQuestions(
  tenantId: string,
  packageId: string,
  count: number,
  scoreFor: (i: number) => number
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    for (let i = 0; i < count; i++) {
      const score = scoreFor(i);
      await client.query(
        `INSERT INTO okf_golden_questions (id, tenant_id, package_id, question, reference_answer, active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [
          randomUUID(),
          tenantId,
          packageId,
          `¿Pregunta doradas número ${i} del paquete? [s:${score}]`,
          `Respuesta de referencia ${i}.`,
        ]
      );
    }
  } finally {
    await client.query('RESET app.tenant_id');
    client.release();
  }
}

// Sanity: el marcador de JUDGE_PROMPT usado por el stub coincide con el real (si alguien cambia
// el texto de JUDGE_PROMPT sin actualizar el test, este check falla explícito en vez de que los
// demás tests fallen de forma confusa).
test('JUDGE_PROMPT contiene el marcador que usa el stub de este archivo', () => {
  const prompt = JUDGE_PROMPT({ question: 'q', reference: 'r', answer: 'a' });
  assert.ok(prompt.includes(JUDGE_MARKER), 'JUDGE_PROMPT debe contener el marcador esperado por el stub');
});

test('10 preguntas con scores altos -> passed true, run insertado con package_id y details sin respuestas', async () => {
  await seedQuestions(TENANT, TEST_PACKAGE_ID, 10, () => 95);
  const llm = makeStubLlm();

  const result = await evalPartnerPackage({
    pool,
    llm,
    partnerId: TEST_PARTNER_ID,
    packageId: TEST_PACKAGE_ID,
  });

  assert.equal(result.questionCount, 10);
  assert.equal(result.score, 95);
  assert.equal(result.passed, true);
  assert.ok(result.runId, 'debe haber runId');
  assert.equal(result.details.length, 10);
  for (const d of result.details) {
    assert.equal(typeof d.question, 'string');
    assert.equal(typeof d.score, 'number');
    assert.ok(!('answer' in d), 'details NO debe incluir la respuesta del modelo');
  }

  const row = await pool.query('SELECT tenant_id, package_id, score, details FROM okf_eval_runs WHERE id = $1', [
    result.runId,
  ]);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].tenant_id, TENANT);
  assert.equal(row.rows[0].package_id, TEST_PACKAGE_ID);
  assert.equal(Number(row.rows[0].score), 95);
  const persistedDetails = row.rows[0].details;
  assert.equal(persistedDetails.length, 10);
  for (const d of persistedDetails) {
    assert.ok(!('answer' in d), 'details persistidos NO deben incluir respuestas del modelo');
  }
});

test('10 preguntas con scores bajos -> passed false, pero el run se inserta igual', async () => {
  await seedQuestions(TENANT, TEST_PACKAGE_ID, 10, () => 40);
  const llm = makeStubLlm();

  const result = await evalPartnerPackage({
    pool,
    llm,
    partnerId: TEST_PARTNER_ID,
    packageId: TEST_PACKAGE_ID,
  });

  assert.equal(result.questionCount, 10);
  assert.equal(result.score, 40);
  assert.equal(result.passed, false);
  assert.ok(result.runId, 'el run debe insertarse aunque no pase');

  const row = await pool.query('SELECT count(*)::int AS n FROM okf_eval_runs WHERE id = $1', [result.runId]);
  assert.equal(row.rows[0].n, 1);
});

test('solo 9 preguntas -> passed false, score null, NO corre el LLM, NO inserta run', async () => {
  await seedQuestions(TENANT, TEST_PACKAGE_ID, 9, () => 95);
  const llm = makeStubLlm();

  const beforeCount = await pool.query('SELECT count(*)::int AS n FROM okf_eval_runs WHERE tenant_id = $1', [TENANT]);

  const result = await evalPartnerPackage({
    pool,
    llm,
    partnerId: TEST_PARTNER_ID,
    packageId: TEST_PACKAGE_ID,
  });

  assert.equal(result.questionCount, 9);
  assert.equal(result.score, null);
  assert.equal(result.passed, false);
  assert.equal(result.runId, null);
  assert.deepEqual(result.details, []);
  assert.equal(llm.calls.length, 0, 'el stub del LLM no debe haber sido invocado');

  const afterCount = await pool.query('SELECT count(*)::int AS n FROM okf_eval_runs WHERE tenant_id = $1', [TENANT]);
  assert.equal(afterCount.rows[0].n, beforeCount.rows[0].n, 'no se insertó ningún run nuevo');
});

test('preguntas de OTRO package (mismo partner) y de OTRO partner no se mezclan', async () => {
  // 10 preguntas del paquete bajo prueba.
  await seedQuestions(TENANT, TEST_PACKAGE_ID, 10, () => 95);
  // Preguntas de otro paquete del MISMO partner (mismo namespace de tenant) — no deben contarse.
  await seedQuestions(TENANT, OTHER_PACKAGE_ID, 15, () => 10);
  // Preguntas de otro partner completamente distinto — tampoco deben contarse.
  await seedQuestions(OTHER_TENANT, OTHER_PARTNER_PACKAGE_ID, 15, () => 10);

  const llm = makeStubLlm();
  const result = await evalPartnerPackage({
    pool,
    llm,
    partnerId: TEST_PARTNER_ID,
    packageId: TEST_PACKAGE_ID,
  });

  assert.equal(result.questionCount, 10, 'solo las 10 del paquete bajo prueba, ninguna de las 30 ajenas');
  assert.equal(result.score, 95);
  assert.equal(result.passed, true);

  // Limpieza explícita de las filas del otro paquete/partner (cleanup() de beforeEach/after ya
  // las cubre por tenant_id, pero lo dejamos explícito para que este test no dependa de orden).
  await pool.query('DELETE FROM okf_golden_questions WHERE package_id IN ($1, $2)', [
    OTHER_PACKAGE_ID,
    OTHER_PARTNER_PACKAGE_ID,
  ]);
});
