// K4-W1 (BACKEND §A6): redactor de PII en dos pasadas sobre title/description/body.
// Pasada 1: regex determinista (emails, teléfonos MX, RFC, CURP, tarjetas con Luhn, URLs con tokens).
// Pasada 2: LLM inyectable (default gemini-2.0-flash vía @google/genai) para PERSONA/DIRECCION.
// Regla A6: el mapa placeholder->valor NUNCA se persiste.

import { GoogleGenAI } from '@google/genai';

export const PII_PROMPT = `Eres un sistema de detección de información personal identificable (PII) para un
wiki corporativo. Se te entrega un texto en español ya pasado por una primera limpieza de
patrones deterministas (emails, teléfonos, RFC, CURP, tarjetas, URLs con tokens ya fueron
reemplazados por placeholders y NO debes tocarlos).

Tu única tarea: identificar en el texto restante:
1. PERSONA: nombres completos de personas físicas que NO sean figuras públicas o de contexto
   corporativo genérico (ej. no marcar "el gerente de ventas", sí marcar "Juan Pérez López").
2. DIRECCION: direcciones físicas (calle, número, colonia, ciudad) que identifiquen una
   ubicación concreta de una persona u oficina no pública.

Devuelve EXCLUSIVAMENTE un JSON (sin texto adicional, sin markdown fences) con la forma:
[{"start": <indice_inicio_char>, "end": <indice_fin_char_exclusivo>, "type": "PERSONA"|"DIRECCION"}, ...]

Los índices start/end son offsets de caracteres (0-based) sobre el texto EXACTO recibido.
Si no hay coincidencias, devuelve exactamente: []`;

export interface PiiSpan {
  start: number;
  end: number;
  type: 'PERSONA' | 'DIRECCION';
}

export interface PiiLlm {
  detectSpans(text: string): Promise<PiiSpan[]>;
}

const DEFAULT_MODEL = 'gemini-2.0-flash';

export class GeminiPiiLlm implements PiiLlm {
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

  async detectSpans(text: string): Promise<PiiSpan[]> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [{ text: `${PII_PROMPT}\n\nTexto:\n${text}` }],
        },
      ],
    });

    const raw = (response.text || '').trim();
    const jsonText = stripFences(raw);
    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (s: any) =>
          typeof s?.start === 'number' &&
          typeof s?.end === 'number' &&
          (s?.type === 'PERSONA' || s?.type === 'DIRECCION')
      );
    } catch {
      return [];
    }
  }
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

// ---------- Pasada 1: regex deterministas ----------

const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

// Teléfonos MX de 10 dígitos con separadores comunes (espacios, guiones, puntos, paréntesis),
// prefijo +52 opcional.
const PHONE_RE = /(?:\+52[\s.-]?)?(?:\(\d{2,3}\)[\s.-]?)?\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{4}/g;

// RFC: [A-ZÑ&]{3,4} + 6 dígitos (fecha) + 3 alfanuméricos (homoclave)
const RFC_RE = /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/g;

// CURP: [A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d
const CURP_RE = /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/g;

// Tarjetas: 13-19 dígitos con separadores opcionales (espacios/guiones)
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

// URLs con query params sensibles (token, key, secret, password)
const URL_RE = /https?:\/\/[^\s)]+\?[^\s)]*(?:token|key|secret|password)=[^\s)]*/gi;

function luhnCheck(digitsOnly: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let d = parseInt(digitsOnly[i], 10);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

interface Match {
  value: string;
  start: number;
  end: number;
  kind: 'EMAIL' | 'TEL' | 'RFC' | 'CURP' | 'TARJETA' | 'URL';
}

function findAll(text: string, re: RegExp, kind: Match['kind'], filter?: (m: string) => boolean): Match[] {
  const out: Match[] = [];
  let m: RegExpExecArray | null;
  const localRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = localRe.exec(text)) !== null) {
    if (!filter || filter(m[0])) {
      out.push({ value: m[0], start: m.index, end: m.index + m[0].length, kind });
    }
    if (m[0].length === 0) localRe.lastIndex++;
  }
  return out;
}

// Pasada 1 (regex) reemplaza por placeholders estables por tipo, en orden de aparición,
// con mapeo mismo-valor -> mismo-placeholder. Los mapas se comparten entre title/description/body
// de un mismo draft (ver redactPii) para que el mismo valor produzca siempre el mismo placeholder.
// Prioridad de tipo para resolver solapes: URL > EMAIL > RFC > CURP > TARJETA > TEL.
type PlaceholderMaps = Record<Match['kind'], Map<string, string>>;

function applyRegexPassWithMaps(
  text: string,
  maps: PlaceholderMaps
): { result: { text: string; replaced: boolean } } {
  // Recolectar matches de todos los patrones y resolver solapes por prioridad + posición.
  const matches: Match[] = [
    ...findAll(text, URL_RE, 'URL'),
    ...findAll(text, EMAIL_RE, 'EMAIL'),
    ...findAll(text, RFC_RE, 'RFC'),
    ...findAll(text, CURP_RE, 'CURP'),
    ...findAll(text, CARD_RE, 'TARJETA', (m) => luhnCheck(m.replace(/[ -]/g, ''))),
    ...findAll(text, PHONE_RE, 'TEL', (m) => m.replace(/\D/g, '').length === 10 || (m.trim().startsWith('+52') && m.replace(/\D/g, '').length === 12)),
  ];

  // Prioridad de tipo cuando hay solape exacto en la misma posición de inicio:
  // URL > EMAIL > RFC > CURP > TARJETA > TEL
  const priority: Record<Match['kind'], number> = {
    URL: 0,
    EMAIL: 1,
    RFC: 2,
    CURP: 3,
    TARJETA: 4,
    TEL: 5,
  };

  matches.sort((a, b) => a.start - b.start || priority[a.kind] - priority[b.kind]);

  const selected: Match[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      selected.push(m);
      lastEnd = m.end;
    }
  }

  if (selected.length === 0) {
    return { result: { text, replaced: false } };
  }

  let out = '';
  let cursor = 0;
  for (const m of selected) {
    out += text.slice(cursor, m.start);
    const map = maps[m.kind];
    let placeholder = map.get(m.value);
    if (!placeholder) {
      placeholder = `[${m.kind}_${map.size + 1}]`;
      map.set(m.value, placeholder);
    }
    out += placeholder;
    cursor = m.end;
  }
  out += text.slice(cursor);

  return { result: { text: out, replaced: true } };
}

// ---------- Pasada 2: LLM (PERSONA/DIRECCION) ----------

function applyLlmSpans(text: string, spans: PiiSpan[], counters: { PERSONA: number; DIRECCION: number }): { text: string; replaced: boolean } {
  if (spans.length === 0) return { text, replaced: false };

  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  let replaced = false;

  for (const span of sorted) {
    if (span.start < cursor || span.start >= span.end || span.end > text.length) {
      continue; // span inválido o solapado, se ignora defensivamente
    }
    out += text.slice(cursor, span.start);
    counters[span.type] += 1;
    out += `[${span.type}_${counters[span.type]}]`;
    cursor = span.end;
    replaced = true;
  }
  out += text.slice(cursor);

  return { text: out, replaced };
}

export interface RedactPiiInput {
  title: string;
  description: string;
  body: string;
}

export interface RedactPiiOutput {
  title: string;
  description: string;
  body: string;
  pii: 'clean' | 'redacted';
}

/**
 * redactPii: aplica pasada 1 (regex, determinista) y pasada 2 (LLM inyectable) sobre
 * title/description/body de un draft. El mapa placeholder->valor NO se persiste (regla A6).
 */
export async function redactPii(input: RedactPiiInput, llm?: PiiLlm): Promise<RedactPiiOutput> {
  const maps: PlaceholderMaps = {
    EMAIL: new Map(),
    TEL: new Map(),
    RFC: new Map(),
    CURP: new Map(),
    TARJETA: new Map(),
    URL: new Map(),
  };

  const passTitle = applyRegexPassWithMaps(input.title, maps).result;
  const passDescription = applyRegexPassWithMaps(input.description, maps).result;
  const passBody = applyRegexPassWithMaps(input.body, maps).result;

  let regexReplaced = passTitle.replaced || passDescription.replaced || passBody.replaced;

  const effectiveLlm = llm ?? new GeminiPiiLlm();
  const counters = { PERSONA: 0, DIRECCION: 0 };

  const [titleSpans, descriptionSpans, bodySpans] = await Promise.all([
    effectiveLlm.detectSpans(passTitle.text),
    effectiveLlm.detectSpans(passDescription.text),
    effectiveLlm.detectSpans(passBody.text),
  ]);

  const titleLlm = applyLlmSpans(passTitle.text, titleSpans, counters);
  const descriptionLlm = applyLlmSpans(passDescription.text, descriptionSpans, counters);
  const bodyLlm = applyLlmSpans(passBody.text, bodySpans, counters);

  const llmReplaced = titleLlm.replaced || descriptionLlm.replaced || bodyLlm.replaced;

  return {
    title: titleLlm.text,
    description: descriptionLlm.text,
    body: bodyLlm.text,
    pii: regexReplaced || llmReplaced ? 'redacted' : 'clean',
  };
}
