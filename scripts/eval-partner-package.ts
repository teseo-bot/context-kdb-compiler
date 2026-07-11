#!/usr/bin/env npx tsx

/**
 * PA7-W2 (TRD-Aliados-Conocimiento-Certificado.md): eval de calidad de un PAQUETE de aliado,
 * gate de la PRIMERA activación de un contrato de ese paquete. Regla de producto: antes de
 * activar el primer contrato, el paquete debe tener >= 10 preguntas doradas etiquetadas con el
 * paquete y una corrida de eval con score >= 80; si no, la activación se rechaza (Knowledge Ops
 * puede hacer override manual, auditado — eso vive del lado del panel, no aquí).
 *
 * El juez es el patrón K5 de night-worker (src/phases/eval.ts de ese repo, LEÍDO y copiado
 * adaptado, NO importado): ANSWER_PROMPT con contexto recuperado + JUDGE_PROMPT. Adaptación:
 * night-worker juzga SI/NO por pregunta y agrega (#SI/total)*100; aquí el JUDGE_PROMPT devuelve
 * directamente un score 0-100 por pregunta (comparando contra `reference_answer`), y el score
 * final del paquete es el PROMEDIO de esos scores por pregunta, redondeado a 2 decimales — así lo
 * pide la regla de producto de este WU.
 *
 * Recuperación de contexto (v1, mismo approach SQL directo que night-worker, pero sobre
 * `okf_partner_concepts` en vez de `okf_concepts`): websearch_to_tsquery('spanish', pregunta)
 * contra `fts`, fallback ILIKE sobre `frontmatter->>'title'`, top 5, filtrado por
 * `package_id = $1`. Nota RLS: `okf_partner_concepts` NO tiene una política que matchee
 * `app.tenant_id = 'partner:...'` (sus políticas son `partner_portal_read` vía `app.partner_id` y
 * `licensed_tenant_read` vía join a `kdb_partner_licenses`) — por eso aquí NO se intenta
 * satisfacer RLS con un SET adicional; el filtro `package_id = $1` explícito en el WHERE es la
 * defensa en profundidad (igual que el resto de las escrituras/lecturas de esta tabla, que corren
 * como rol de servicio — ver nota en migrations/007_partner_index.sql).
 *
 * Namespace de tenant para las filas de `okf_golden_questions`/`okf_eval_runs` de un paquete:
 * 'partner:{partner_id}' (migrations/008_partner_eval.sql). Se hace SET app.tenant_id con ese
 * valor en un client dedicado del pool, con try/finally RESET (mismo patrón que
 * src/indexing/indexer.ts).
 *
 * Núcleo inyectable (`evalPartnerPackage(deps)`) + `main()` para wiring real — mismo patrón que
 * scripts/aggregate-partner-citations.ts. El cliente LLM real reutiliza `GeminiDistillerLlm`
 * (src/ingestion/distiller-v2.ts, ya usado por src/partners/partner-assist.ts): mismo modelo para
 * responder y juzgar, sin dependencias nuevas.
 *
 * Uso:
 *   COLD_TIER_URL=postgres://... npx tsx scripts/eval-partner-package.ts \
 *     --partner-id=<uuid> --package-id=<uuid>
 */

import { Pool, PoolClient } from 'pg';
import { GeminiDistillerLlm } from '../src/ingestion/distiller-v2';
import { MIN_QUESTIONS_DEFAULT, PASS_SCORE_DEFAULT } from '../src/partners/eval-gate';

const TOP_K = 5;

// ==================== Prompts (adaptados del patrón K5 de night-worker) ====================

export const ANSWER_PROMPT = (opts: { question: string; context: string }): string => {
  return `Eres un asistente que responde preguntas usando EXCLUSIVAMENTE el contexto provisto.
No inventes información que no esté en el contexto. Si el contexto no alcanza para responder,
dilo explícitamente.

## Contexto

${opts.context || '(sin contexto disponible)'}

## Pregunta

${opts.question}

Responde de forma concisa y directa, basándote solo en el contexto anterior.`;
};

// Marcador único usado por los tests (A4) para distinguir esta llamada de ANSWER_PROMPT sin
// tener que parsear el prompt completo: "Formato exacto: un entero" no aparece en ANSWER_PROMPT.
export const JUDGE_PROMPT = (opts: { question: string; reference: string; answer: string }): string => {
  return `Eres un juez que evalúa qué tan equivalente en contenido es una respuesta generada
respecto de una respuesta de referencia, para la misma pregunta. Asigna un score de 0 (nada
equivalente) a 100 (totalmente equivalente).

## Pregunta

${opts.question}

## Respuesta de referencia (correcta)

${opts.reference}

## Respuesta generada (a evaluar)

${opts.answer}

Responde SOLO con el número del score, sin texto adicional. Formato exacto: un entero entre 0 y 100.`;
};

/**
 * Parseo tolerante del score numérico (mismo espíritu que `parseVerdict` de night-worker: nunca
 * lanza, siempre devuelve un score en [0,100]). Respuesta iletrable (sin ningún número) → 0
 * (conservador, no infla el score).
 */
export function parseScore(raw: string): number {
  const match = raw.match(/-?\d+(\.\d+)?/);
  if (!match) return 0;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ==================== Recuperación de contexto (okf_partner_concepts) ====================

interface ConceptContextRow {
  path: string;
  title: string;
  body_text: string;
}

async function retrieveContext(
  client: PoolClient,
  packageId: string,
  question: string
): Promise<ConceptContextRow[]> {
  const ftsRes = await client.query<ConceptContextRow>(
    `SELECT path, frontmatter->>'title' AS title, body_text
     FROM okf_partner_concepts
     WHERE package_id = $1
       AND fts @@ websearch_to_tsquery('spanish', $2)
     ORDER BY ts_rank(fts, websearch_to_tsquery('spanish', $2)) DESC
     LIMIT $3`,
    [packageId, question, TOP_K]
  );

  if (ftsRes.rows.length > 0) {
    return ftsRes.rows;
  }

  const ilikeRes = await client.query<ConceptContextRow>(
    `SELECT path, frontmatter->>'title' AS title, body_text
     FROM okf_partner_concepts
     WHERE package_id = $1
       AND frontmatter->>'title' ILIKE '%' || $2 || '%'
     ORDER BY updated_at DESC
     LIMIT $3`,
    [packageId, question, TOP_K]
  );

  return ilikeRes.rows;
}

function buildContextText(rows: ConceptContextRow[]): string {
  return rows
    .map((r) => `### ${r.title || r.path} (${r.path})\n\n${r.body_text}`)
    .join('\n\n---\n\n');
}

// ==================== Núcleo inyectable ====================

export interface EvalDeps {
  pool: Pool; // Cold-Tier
  llm: { generate(prompt: string): Promise<string> }; // answer + judge (mismo cliente)
  partnerId: string;
  packageId: string;
  modelVersion?: string;
  minQuestions?: number; // default 10
  passScore?: number; // default 80
}

export interface EvalRunResult {
  questionCount: number;
  score: number | null;
  passed: boolean;
  runId: string | null;
  details: { question: string; score: number }[];
}

interface GoldenQuestionRow {
  id: string;
  question: string;
  reference_answer: string;
}

export async function evalPartnerPackage(deps: EvalDeps): Promise<EvalRunResult> {
  const minQuestions = deps.minQuestions ?? MIN_QUESTIONS_DEFAULT;
  const passScore = deps.passScore ?? PASS_SCORE_DEFAULT;
  const tenantId = `partner:${deps.partnerId}`;

  const client = await deps.pool.connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);

    const questionsRes = await client.query<GoldenQuestionRow>(
      `SELECT id, question, reference_answer
       FROM okf_golden_questions
       WHERE tenant_id = $1 AND package_id = $2 AND active = true`,
      [tenantId, deps.packageId]
    );
    const questions = questionsRes.rows;

    if (questions.length < minQuestions) {
      console.log(
        `[eval-partner-package] paquete ${deps.packageId}: ${questions.length} preguntas doradas ` +
          `activas (< ${minQuestions} requeridas) — eval NO se corre, passed=false, score=null`
      );
      return { questionCount: questions.length, score: null, passed: false, runId: null, details: [] };
    }

    const details: { question: string; score: number }[] = [];

    for (const q of questions) {
      const contextRows = await retrieveContext(client, deps.packageId, q.question);
      const contextText = buildContextText(contextRows);

      const answer = await deps.llm.generate(ANSWER_PROMPT({ question: q.question, context: contextText }));
      const judgeRaw = await deps.llm.generate(
        JUDGE_PROMPT({ question: q.question, reference: q.reference_answer, answer })
      );
      const score = parseScore(judgeRaw);

      details.push({ question: q.question, score });
    }

    const finalScore = Math.round((details.reduce((acc, d) => acc + d.score, 0) / details.length) * 100) / 100;
    const passed = questions.length >= minQuestions && finalScore >= passScore;

    const insertRes = await client.query<{ id: string }>(
      `INSERT INTO okf_eval_runs (tenant_id, score, details, model_version, package_id)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id`,
      [tenantId, finalScore, JSON.stringify(details), deps.modelVersion ?? null, deps.packageId]
    );

    console.log(
      `[eval-partner-package] paquete ${deps.packageId}: ${questions.length} preguntas, score=${finalScore}, ` +
        `passed=${passed}, run_id=${insertRes.rows[0].id}`
    );

    return {
      questionCount: questions.length,
      score: finalScore,
      passed,
      runId: insertRes.rows[0].id,
      details,
    };
  } finally {
    await client.query('RESET app.tenant_id');
    client.release();
  }
}

// ==================== main(): wiring REAL ====================

function parseArgs(argv: string[]): { partnerId: string; packageId: string } {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  const partnerId = args['partner-id'];
  const packageId = args['package-id'];
  if (!partnerId || !packageId) {
    throw new Error('Uso: npx tsx scripts/eval-partner-package.ts --partner-id=<uuid> --package-id=<uuid>');
  }
  return { partnerId, packageId };
}

async function main(): Promise<void> {
  const dbUrl =
    process.env.COLD_TIER_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

  const { partnerId, packageId } = parseArgs(process.argv.slice(2));

  const pool = new Pool({ connectionString: dbUrl });
  // Reusa el cliente LLM real ya existente en el repo (src/ingestion/distiller-v2.ts,
  // ya usado por src/partners/partner-assist.ts): mismo modelo para responder y juzgar,
  // CERO dependencias nuevas.
  const llm = new GeminiDistillerLlm();

  try {
    const result = await evalPartnerPackage({ pool, llm, partnerId, packageId });
    console.log('[eval-partner-package] OK', result);
  } catch (error) {
    console.error('[eval-partner-package] Error durante la eval:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module || process.argv[1]?.endsWith('eval-partner-package.ts')) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
