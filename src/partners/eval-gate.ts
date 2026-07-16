/**
 * PA7-W2 (TRD-Aliados-Conocimiento-Certificado.md): umbrales y decisión de "passed" del gate de
 * eval de paquete, compartidos entre:
 *  - `scripts/eval-partner-package.ts`, que corre la eval y decide `passed` al insertar una
 *    corrida nueva en okf_eval_runs.
 *  - La ruta interna `GET /internal/partner-package-eval-status` (src/server.ts, vía
 *    `src/partners/partner-eval-status.ts`), que decide `passed` sobre la ÚLTIMA corrida ya
 *    persistida, para que el panel (teseo-control) pueda consultarlo sin tocar el Cold-Tier
 *    directo.
 *
 * Single source of truth: si estos umbrales cambian, cambian aquí y en ningún otro lado.
 */

export const MIN_QUESTIONS_DEFAULT = 10;
export const PASS_SCORE_DEFAULT = 80;

/**
 * `passed` requiere AMBAS condiciones: al menos `minQuestions` preguntas doradas activas del
 * paquete, Y un score (0-100) >= `passScore`. `score === null` (sin corrida, o preguntas
 * insuficientes) siempre es `false`.
 */
export function computePassed(
  questionCount: number,
  score: number | null,
  minQuestions: number = MIN_QUESTIONS_DEFAULT,
  passScore: number = PASS_SCORE_DEFAULT
): boolean {
  return questionCount >= minQuestions && score !== null && score >= passScore;
}
