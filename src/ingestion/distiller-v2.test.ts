import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { distillCandidate, DistillerLlm } from './distiller-v2';
import { HocflitHint } from '../schemas/contracts';

const CANDIDATE = {
  kind: 'conversation_closed',
  source_ref: 'conv:thread-123',
  payload_summary: 'Cliente preguntó por objeciones de precio en sector salud.',
};

const VALID_DRAFT_JSON = JSON.stringify({
  type: 'Insight',
  title: 'Objeciones de precio en sector salud',
  description: 'Patrón recurrente de objeciones de precio observado en leads de salud.',
  tags: ['c-comercial', 'precio'],
  timestamp: '2026-07-01T10:00:00.000Z',
  sources: ['conv:thread-123'],
  confidence: 'draft',
  pii: 'clean',
  altitude: 2,
  body: 'Cuerpo destilado del concepto sobre objeciones de precio.',
});

class ScriptedLlm implements DistillerLlm {
  private calls: string[] = [];
  constructor(private responses: string[]) {}

  async generate(prompt: string): Promise<string> {
    this.calls.push(prompt);
    const response = this.responses[this.calls.length - 1];
    if (response === undefined) {
      throw new Error('ScriptedLlm: no hay más respuestas programadas');
    }
    return response;
  }

  get prompts() {
    return this.calls;
  }
}

test('LLM simulado con JSON válido → draft válido con confidence "draft"', async () => {
  const llm = new ScriptedLlm([VALID_DRAFT_JSON]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo de la conversación', llm);

  assert.equal(draft.frontmatter.confidence, 'draft');
  assert.equal(draft.frontmatter.title, 'Objeciones de precio en sector salud');
  assert.equal(draft.frontmatter.tags[0], 'c-comercial');
  assert.equal(draft.body, 'Cuerpo destilado del concepto sobre objeciones de precio.');
});

test('LLM que devuelve JSON válido envuelto en fences ```json también se parsea', async () => {
  const fenced = '```json\n' + VALID_DRAFT_JSON + '\n```';
  const llm = new ScriptedLlm([fenced]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm);
  assert.equal(draft.frontmatter.confidence, 'draft');
});

test('LLM que fuerza confidence !== "draft" es sobrescrito por código', async () => {
  const tampered = JSON.stringify({
    ...JSON.parse(VALID_DRAFT_JSON),
    confidence: 'consolidated',
  });
  const llm = new ScriptedLlm([tampered]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm);
  assert.equal(draft.frontmatter.confidence, 'draft');
});

test('LLM que devuelve JSON inválido 2 veces → throw', async () => {
  const llm = new ScriptedLlm(['esto no es json', 'tampoco esto es json']);
  await assert.rejects(distillCandidate(CANDIDATE, 'contenido crudo', llm));
});

test('LLM que devuelve inválido la 1a vez y válido la 2a → éxito, y el 2o prompt contiene el error de Zod/parseo', async () => {
  const llm = new ScriptedLlm(['{"title": "incompleto"}', VALID_DRAFT_JSON]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm);

  assert.equal(draft.frontmatter.confidence, 'draft');
  assert.equal(llm.prompts.length, 2);
  // El segundo prompt debe incluir el prompt original + el error de validación anexado.
  assert.match(llm.prompts[1], /ATENCION/);
  assert.ok(llm.prompts[1].length > llm.prompts[0].length);
});

test('LLM cuya 1a respuesta falla validación Zod (falta altitude) y 2a también falla → throw con ambos errores', async () => {
  const missingAltitude = JSON.stringify({
    ...JSON.parse(VALID_DRAFT_JSON),
    altitude: undefined,
  });
  const llm = new ScriptedLlm([missingAltitude, 'no json en absoluto']);
  await assert.rejects(distillCandidate(CANDIDATE, 'contenido crudo', llm), (err: Error) => {
    assert.match(err.message, /Error 1:/);
    assert.match(err.message, /Error 2:/);
    return true;
  });
});

// ---------- K9-W1: hocflit_hint (SPEC-K9 §2.4) ----------

const HINT_COMERCIAL: HocflitHint = {
  system: 'c-comercial',
  tags: ['pricing'],
  source_module: 'crm-comercial',
};

test('K9-W1: con hint y LLM que clasifica DISTINTO → tags[0]=hint.system y tag "sugerido:{otro}"', async () => {
  // El LLM clasifica en f-finanzas, distinto del hint (c-comercial).
  const llmDiffers = JSON.stringify({
    ...JSON.parse(VALID_DRAFT_JSON),
    tags: ['f-finanzas', 'precio'],
  });
  const llm = new ScriptedLlm([llmDiffers]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm, HINT_COMERCIAL);

  assert.equal(draft.frontmatter.tags[0], 'c-comercial');
  assert.ok(draft.frontmatter.tags.includes('sugerido:f-finanzas'));
});

test('K9-W1: con hint y LLM que COINCIDE → tags[0]=hint.system sin tag "sugerido:"', async () => {
  // El LLM ya clasifica en c-comercial, igual que el hint.
  const llmMatches = JSON.stringify({
    ...JSON.parse(VALID_DRAFT_JSON),
    tags: ['c-comercial', 'precio'],
  });
  const llm = new ScriptedLlm([llmMatches]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm, HINT_COMERCIAL);

  assert.equal(draft.frontmatter.tags[0], 'c-comercial');
  assert.ok(!draft.frontmatter.tags.some((t) => t.startsWith('sugerido:')));
});

test('K9-W1: sin hint → comportamiento actual intacto (tags del LLM sin modificar)', async () => {
  const llm = new ScriptedLlm([VALID_DRAFT_JSON]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm);

  assert.deepEqual(draft.frontmatter.tags, ['c-comercial', 'precio']);
});

test('K9-W1: con hint, el prompt se prefija con el texto de origen del módulo', async () => {
  const llm = new ScriptedLlm([VALID_DRAFT_JSON]);
  await distillCandidate(CANDIDATE, 'contenido crudo', llm, HINT_COMERCIAL);

  assert.match(llm.prompts[0], /proviene del módulo crm-comercial del sistema c-comercial/);
  assert.match(llm.prompts[0], /pricing/);
});

// ---------- K10-W1: altitude_min (piso de altitud) ----------

const HINT_DIRECCION_ALTITUDE_4: HocflitHint = {
  system: 'i-innovacion',
  source_module: 'direccion',
  altitude_min: 4,
};

test('K10-W1: hint con altitude_min=4 y LLM que responde altitude=2 → draft final altitude=4', async () => {
  const llmLowAltitude = JSON.stringify({
    ...JSON.parse(VALID_DRAFT_JSON),
    tags: ['i-innovacion', 'estrategia'],
    altitude: 2,
  });
  const llm = new ScriptedLlm([llmLowAltitude]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm, HINT_DIRECCION_ALTITUDE_4);

  assert.equal(draft.frontmatter.altitude, 4);
});

test('K10-W1: LLM responde altitude=5 con piso=4 → queda 5 (piso, no override total)', async () => {
  const llmHighAltitude = JSON.stringify({
    ...JSON.parse(VALID_DRAFT_JSON),
    tags: ['i-innovacion', 'estrategia'],
    altitude: 5,
  });
  const llm = new ScriptedLlm([llmHighAltitude]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm, HINT_DIRECCION_ALTITUDE_4);

  assert.equal(draft.frontmatter.altitude, 5);
});

test('K10-W1: hint sin altitude_min → altitude del LLM intacta', async () => {
  const llmAltitude2 = JSON.stringify({
    ...JSON.parse(VALID_DRAFT_JSON),
    altitude: 2,
  });
  const llm = new ScriptedLlm([llmAltitude2]);
  const draft = await distillCandidate(CANDIDATE, 'contenido crudo', llm, HINT_COMERCIAL);

  assert.equal(draft.frontmatter.altitude, 2);
});

test('K10-W1: el prompt contiene la mención del piso de altitud cuando hint.altitude_min está presente', async () => {
  const llm = new ScriptedLlm([VALID_DRAFT_JSON]);
  await distillCandidate(CANDIDATE, 'contenido crudo', llm, HINT_DIRECCION_ALTITUDE_4);

  assert.match(
    llm.prompts[0],
    /Este conocimiento proviene de un módulo de nivel estratégico; su altitud mínima es 4 en la escala 1-5/
  );
});

test('K10-W1: el prompt NO contiene la mención del piso cuando hint.altitude_min está ausente', async () => {
  const llm = new ScriptedLlm([VALID_DRAFT_JSON]);
  await distillCandidate(CANDIDATE, 'contenido crudo', llm, HINT_COMERCIAL);

  assert.doesNotMatch(llm.prompts[0], /altitud mínima/);
});
