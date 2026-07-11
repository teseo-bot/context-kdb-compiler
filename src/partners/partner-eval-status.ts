/**
 * PA7-W2: lógica de consulta para la ruta interna M2M `GET /internal/partner-package-eval-status`
 * (src/server.ts, mismo patrón de auth `x-api-key === M2M_API_KEY` que el resto de /internal/*).
 * El panel (teseo-control) NUNCA consulta el Cold-Tier directo: llama esta ruta vía su
 * `lib/partners/compiler-client.ts` antes de activar el PRIMER contrato de un paquete de aliado.
 *
 * `passed` usa la MISMA definición que `scripts/eval-partner-package.ts` — ambos importan las
 * constantes/decisión de `src/partners/eval-gate.ts` (single source of truth).
 */

import { Pool } from 'pg';
import { computePassed } from './eval-gate';

export interface PartnerPackageEvalStatus {
  question_count: number;
  latest: { score: number; run_at: string; id: string } | null;
  passed: boolean;
}

export async function getPartnerPackageEvalStatus(
  pool: Pool,
  packageId: string,
  partnerId: string
): Promise<PartnerPackageEvalStatus> {
  const tenantId = `partner:${partnerId}`;
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);

    const questionsRes = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM okf_golden_questions
       WHERE tenant_id = $1 AND package_id = $2 AND active = true`,
      [tenantId, packageId]
    );
    const questionCount = Number(questionsRes.rows[0]?.count ?? 0);

    const runRes = await client.query<{ id: string; score: string; run_at: string }>(
      `SELECT id, score, run_at
       FROM okf_eval_runs
       WHERE tenant_id = $1 AND package_id = $2
       ORDER BY run_at DESC
       LIMIT 1`,
      [tenantId, packageId]
    );

    const latest = runRes.rows[0]
      ? {
          id: runRes.rows[0].id,
          score: Number(runRes.rows[0].score),
          run_at: new Date(runRes.rows[0].run_at).toISOString(),
        }
      : null;

    const passed = computePassed(questionCount, latest ? latest.score : null);

    return { question_count: questionCount, latest, passed };
  } finally {
    await client.query('RESET app.tenant_id');
    client.release();
  }
}
