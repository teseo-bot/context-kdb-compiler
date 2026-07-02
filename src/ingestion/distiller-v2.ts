// K4-W1 (BACKEND §A4): destilación L1 para la ruta V2. Reemplaza las heurísticas regex del
// distiller legacy (src/ingestion/distiller.ts) para candidates provenientes de
// knowledge_candidates. El distiller legacy NO se modifica (queda para ingesta directa de documentos).

import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { ConceptFrontmatterSchema } from '../infrastructure/concept-frontmatter.schema';
import { HocflitHint } from '../schemas/contracts';

export const DISTILL_PROMPT = `Eres el destilador de nivel 1 (L1) del Cerebro Virtual Corporativo OKF de Teseo AI.
Tu tarea es transformar contenido crudo (conversación cerrada o documento ingerido) en UN
concepto de wiki corporativo, denso y accionable, listo para revisión editorial posterior.

REGLAS DE SALIDA (obligatorias):
- Debes responder ÚNICAMENTE con un objeto JSON válido. SIN markdown fences (nada de \`\`\`),
  SIN texto antes o después, SIN comentarios.
- El JSON debe tener EXACTAMENTE esta forma (no agregues ni quites campos; NO incluyas
  draft_id, tenant_id ni target_path — esos los asigna el sistema):

{
  "type": "Insight" | "Perfil" | "Politica" | "Proceso" | "Metrica" | "Riesgo" | "Fuente",
  "title": "string ≤120 caracteres",
  "description": "string ≤240 caracteres",
  "tags": ["<slug-sistema>", "<tag-libre>", "..."],
  "timestamp": "ISO8601 UTC, ej. 2026-07-01T10:00:00.000Z",
  "sources": ["<source-ref>", "..."],
  "confidence": "draft",
  "pii": "clean" | "redacted",
  "altitude": 1 | 2 | 3 | 4 | 5,
  "body": "cuerpo en markdown, ≤8000 caracteres"
}

REGLAS DE CONTENIDO:
1. DENSIDAD: el campo "body" debe ser denso y accionable, ≤8000 caracteres. No incluyas
   relleno, saludos ni transcripciones literales innecesarias: sintetiza.
2. SOURCES: "sources" es OBLIGATORIO y debe tener al menos un elemento. Usa el source_ref
   del candidate que se te provee (no inventes otros). Formatos válidos: conv:{thread_id},
   doc:sha256:{hash}, db:{tabla}:{id}, url:{https://...}.
3. TAGS[0] = SISTEMA HOCFLIT: el primer elemento de "tags" DEBE ser exactamente uno de estos
   7 slugs (elige el más apropiado según el contenido):
   - h-talento-humano: personas, cultura organizacional, desempeño, contratación, clima laboral.
   - o-operaciones: procesos internos, logística, ejecución del día a día, calidad operativa.
   - c-comercial: ventas, clientes, objeciones, pipeline, negociación, marketing comercial.
   - f-finanzas: presupuesto, costos, ingresos, flujo de caja, reportes financieros.
   - l-legal: contratos, cumplimiento normativo, riesgos legales, políticas regulatorias.
   - i-innovacion: nuevas iniciativas, investigación, producto, experimentación estratégica.
   - t-tecnologia: infraestructura técnica, software, datos, arquitectura de sistemas.
4. ALTITUDE (escala 1-5, elige la que mejor represente el nivel de abstracción del concepto):
   - 1 (operativo puro): un dato o hecho aislado de una sola interacción. Ej: "El cliente X
     preguntó el precio del plan Pro el 3 de junio."
   - 2 (patrón local): una observación repetida en pocos casos. Ej: "Varios leads del sector
     salud mencionan preocupación por el costo de implementación."
   - 3 (patrón consolidado): un patrón recurrente y accionable a nivel de equipo/área. Ej:
     "La objeción de precio en sector salud se resuelve mejor mostrando ROI a 12 meses."
   - 4 (política/proceso de área): una regla o proceso que gobierna cómo opera un área. Ej:
     "Todo lead de sector salud con objeción de precio debe recibir el caso de ROI antes del
     día 3 del pipeline."
   - 5 (estratégico corporativo): una directriz que afecta a la organización completa. Ej:
     "La estrategia de precios de la empresa prioriza ROI demostrable sobre descuentos directos."
5. NO asignes "confidence" distinto de "draft" (el sistema lo fuerza de todas formas).
6. "pii": indica si detectaste información personal identificable sin redactar en el
   contenido que estás destilando; el sistema aplicará su propio redactor después, así que
   usa tu mejor criterio aquí como señal inicial.`;

export interface DistillerLlm {
  generate(prompt: string): Promise<string>;
}

const DEFAULT_MODEL = 'gemini-2.0-flash';

export class GeminiDistillerLlm implements DistillerLlm {
  private ai: GoogleGenAI;
  private model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    const apiKey =
      opts?.apiKey ??
      process.env.GEMINI_DIRECT_KEY ??
      process.env.GEMINI_API_KEYS?.split(',')[0] ??
      '';
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    return response.text || '';
  }
}

export interface DistillCandidateInput {
  kind: string;
  source_ref: string;
  payload_summary: string;
}

// Shape del draft SIN draft_id/tenant_id/target_path (los pone el código llamador, K4-W2).
export const DistillOutputSchema = z.object({
  frontmatter: ConceptFrontmatterSchema,
  body: z.string().min(1).max(8000),
});
export type DraftShape = z.infer<typeof DistillOutputSchema>;

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * K9-W1 (SPEC-K9 §2.4.a): prefijo de prompt cuando el candidate trae un hint HOCFLIT de
 * origen (texto copiado de la spec, con las variables del hint interpoladas).
 * K10-W1: si el hint trae altitude_min, se añade una segunda línea que informa al LLM
 * del piso de altitud (el LLM sigue eligiendo su altitude; el código aplica el piso después
 * en parseAndValidate, no lo sobrescribe salvo que quede por debajo del mínimo).
 */
function buildHintPrefix(hint: HocflitHint): string {
  const tagsText = hint.tags && hint.tags.length > 0 ? hint.tags.join(', ') : '';
  const basePrefix = `Este documento proviene del módulo ${hint.source_module} del sistema ${hint.system}; clasifícalo en ese sistema salvo evidencia fuerte en contra, y añade los tags: ${tagsText}`;
  if (hint.altitude_min === undefined) {
    return basePrefix;
  }
  return `${basePrefix}\nEste conocimiento proviene de un módulo de nivel estratégico; su altitud mínima es ${hint.altitude_min} en la escala 1-5`;
}

function buildPrompt(candidate: DistillCandidateInput, rawContent: string, hint?: HocflitHint): string {
  const hintPrefix = hint ? `${buildHintPrefix(hint)}\n\n` : '';
  return `${hintPrefix}${DISTILL_PROMPT}

CANDIDATE:
- kind: ${candidate.kind}
- source_ref: ${candidate.source_ref}
- payload_summary: ${candidate.payload_summary}

CONTENIDO CRUDO A DESTILAR:
${rawContent}`;
}

/**
 * Parsea el texto de respuesta del LLM (tolerante a fences ```json) y valida contra el
 * shape esperado {type,title,description,tags,timestamp,sources,confidence,pii,altitude,body}.
 * confidence se fuerza a 'draft' por código (no se confía en el LLM). Lanza ZodError o
 * SyntaxError si la validación/parseo falla.
 *
 * K9-W1 (SPEC-K9 §2.4.b): si se provee `hint`, tras validar el draft se FUERZA
 * tags[0] = hint.system por código. Si la clasificación del LLM (tags[0] original) difería
 * del sistema del hint, se conserva como tag secundario con prefijo 'sugerido:' para
 * auditoría HITL. Si el LLM coincidió con el hint, no se agrega tag 'sugerido:'.
 *
 * K10-W1: si el hint trae altitude_min, se aplica como PISO (no override total):
 * altitude = Math.max(altitude_llm, hint.altitude_min). Si el LLM ya eligió una altitude
 * mayor o igual al piso, se conserva la del LLM intacta. Sin altitude_min, el comportamiento
 * es exactamente el previo (altitude del LLM sin tocar).
 */
function parseAndValidate(rawText: string, hint?: HocflitHint): DraftShape {
  const jsonText = stripFences(rawText);
  const parsed = JSON.parse(jsonText);

  const { body, ...frontmatterFields } = parsed ?? {};
  const frontmatter = { ...frontmatterFields, confidence: 'draft' };

  const draft = DistillOutputSchema.parse({ frontmatter, body });

  if (!hint) {
    return draft;
  }

  const llmTags = draft.frontmatter.tags;
  const llmSystem = llmTags[0];
  const restTags = llmTags.slice(1);
  const forcedTags =
    llmSystem === hint.system ? [hint.system, ...restTags] : [hint.system, ...restTags, `sugerido:${llmSystem}`];

  const forcedAltitude =
    hint.altitude_min === undefined
      ? draft.frontmatter.altitude
      : Math.max(draft.frontmatter.altitude, hint.altitude_min);

  return {
    ...draft,
    frontmatter: {
      ...draft.frontmatter,
      tags: forcedTags,
      altitude: forcedAltitude,
    },
  };
}

/**
 * distillCandidate: arma el prompt, llama al LLM, parsea y valida la respuesta.
 * Si la validación falla, hace 1 reintento anexando el error al prompt; si falla la 2a vez,
 * lanza un Error que incluye ambos mensajes de error.
 */
export async function distillCandidate(
  candidate: DistillCandidateInput,
  rawContent: string,
  llm?: DistillerLlm,
  hint?: HocflitHint
): Promise<DraftShape> {
  const effectiveLlm = llm ?? new GeminiDistillerLlm();
  const basePrompt = buildPrompt(candidate, rawContent, hint);

  let firstError: unknown;
  try {
    const firstResponse = await effectiveLlm.generate(basePrompt);
    return parseAndValidate(firstResponse, hint);
  } catch (error) {
    firstError = error;
  }

  const firstErrorMessage = firstError instanceof Error ? firstError.message : String(firstError);
  const retryPrompt = `${basePrompt}

ATENCION: tu respuesta anterior no fue un JSON válido conforme al schema esperado. Error:
${firstErrorMessage}

Corrige el problema y responde de nuevo ÚNICAMENTE con el JSON válido conforme a las reglas de salida.`;

  try {
    const secondResponse = await effectiveLlm.generate(retryPrompt);
    return parseAndValidate(secondResponse, hint);
  } catch (secondError) {
    const secondErrorMessage = secondError instanceof Error ? secondError.message : String(secondError);
    throw new Error(
      `distillCandidate: fallo tras 1 reintento.\nError 1: ${firstErrorMessage}\nError 2: ${secondErrorMessage}`
    );
  }
}
