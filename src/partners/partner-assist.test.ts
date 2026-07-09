/**
 * KL3-W2: Tests dirigidos del asistente IA del Knowledge Lab (partner-assist.ts)
 *
 * Scope:
 *  1. reorganize → markdown re-validado con report adjunto
 *  2. [INV-KL4] ref no provista en sources del LLM → se elimina y aparece en stripped_refs
 *  3. fix_findings sin findings → PartnerAssistInputError (422 en server.ts)
 *  4. LLM que lanza → PartnerAssistLlmError (502 en server.ts) [INV-KL6]
 *  5. [INV-KL3] partner-assist.ts nunca invoca BundleStore.write (no persiste nada)
 *  + draft_from_source: lee material de _fuentes/ y cita solo esas refs
 *  + draft_from_source sin source_gcs_objects → 422
 *
 * LLM: mismo mecanismo de inyección que distiller-v2.test.ts (clase que implementa
 * DistillerLlm.generate(prompt) con respuestas guionadas) y GCS simulado idéntico a
 * partner-ingest.test.ts (InMemoryStorageBackend implementando BundleStorageBackend).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  BundleStore,
  BundleStorageBackend,
  GenerationMismatchError,
  ReadResult,
  StoredObjectMeta,
} from '../infrastructure/bundle-store';
import { DistillerLlm } from '../ingestion/distiller-v2';
import {
  runPartnerAssist,
  PartnerAssistInput,
  PartnerAssistInputError,
  PartnerAssistLlmError,
} from './partner-assist';

// ==================== GCS simulado (idéntico a partner-ingest.test.ts) ====================

class InMemoryStorageBackend implements BundleStorageBackend {
  versions = new Map<string, { content: string; generation: bigint }[]>();
  private nextGeneration = 1n;

  async read(path: string): Promise<ReadResult | null> {
    const list = this.versions.get(path);
    if (!list || list.length === 0) return null;
    const latest = list[list.length - 1];
    return { content: latest.content, generation: latest.generation };
  }

  async list(prefix: string): Promise<StoredObjectMeta[]> {
    const out: StoredObjectMeta[] = [];
    for (const [p, list] of this.versions.entries()) {
      if (p.startsWith(prefix) && list.length > 0) {
        out.push({ path: p, generation: list[list.length - 1].generation });
      }
    }
    return out;
  }

  async save(path: string, content: string, opts?: { ifGenerationMatch?: bigint }): Promise<bigint> {
    const list = this.versions.get(path) ?? [];
    const currentGeneration = list.length > 0 ? list[list.length - 1].generation : 0n;

    if (opts?.ifGenerationMatch !== undefined && opts.ifGenerationMatch !== currentGeneration) {
      throw new GenerationMismatchError(path);
    }

    const generation = this.nextGeneration++;
    list.push({ content, generation });
    this.versions.set(path, list);
    return generation;
  }
}

// ==================== Mock del LLM (mismo patrón que distiller-v2.test.ts::ScriptedLlm) =======

class ScriptedLlm implements DistillerLlm {
  private calls = 0;
  constructor(private responses: (string | Error)[]) {}

  async generate(_prompt: string): Promise<string> {
    const response = this.responses[this.calls];
    this.calls += 1;
    if (response === undefined) {
      throw new Error('ScriptedLlm: no hay más respuestas programadas');
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

// ==================== Fixtures ====================

const TEST_PARTNER_ID = '550e8400-e29b-41d4-a716-446655440002';

const VALID_CONCEPT_MARKDOWN = `---
type: Insight
title: "Objeciones de precio en sector salud"
description: "Patron recurrente observado en leads de salud."
tags: ["c-comercial", "precio"]
timestamp: "2026-07-01T10:00:00.000Z"
sources: ["conv:thread-123"]
confidence: draft
pii: clean
altitude: 2
---

Cuerpo del concepto con contenido denso y accionable sobre objeciones de precio.
`;

// ==================== Tests ====================

test('reorganize: devuelve markdown re-validado con report adjunto', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const llm = new ScriptedLlm([VALID_CONCEPT_MARKDOWN]);

  const input: PartnerAssistInput = {
    mode: 'reorganize',
    partner_id: TEST_PARTNER_ID,
    markdown: VALID_CONCEPT_MARKDOWN,
  };

  const result = await runPartnerAssist(input, store, llm);

  assert.equal(result.markdown.includes('type: Insight'), true);
  assert.equal(result.stripped_refs.length, 0);
  assert.equal(typeof result.report.valid, 'boolean');
  assert.equal(Array.isArray(result.report.findings), true);
});

test('[INV-KL4] ref no provista en sources del LLM se elimina y aparece en stripped_refs', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  // El LLM "obedece" el prompt-injection embebido en una fuente hipotética e intenta colar
  // una URL no provista en sources. El código NO debe confiar en que el LLM obedeció la
  // instrucción de no inventar refs.
  const tampered = VALID_CONCEPT_MARKDOWN.replace(
    'sources: ["conv:thread-123"]',
    'sources: ["conv:thread-123", "url:https://evil.example.com/inyectado"]'
  );
  const llm = new ScriptedLlm([tampered]);

  const input: PartnerAssistInput = {
    mode: 'reorganize',
    partner_id: TEST_PARTNER_ID,
    markdown: VALID_CONCEPT_MARKDOWN, // sources de entrada: solo conv:thread-123
  };

  const result = await runPartnerAssist(input, store, llm);

  assert.deepEqual(result.stripped_refs, ['url:https://evil.example.com/inyectado']);
  assert.equal(result.markdown.includes('evil.example.com'), false);
  assert.equal(result.markdown.includes('conv:thread-123'), true);
});

test('fix_findings sin findings → PartnerAssistInputError (422 en server.ts)', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const llm = new ScriptedLlm([VALID_CONCEPT_MARKDOWN]);

  const input: PartnerAssistInput = {
    mode: 'fix_findings',
    partner_id: TEST_PARTNER_ID,
    markdown: VALID_CONCEPT_MARKDOWN,
    findings: [],
  };

  await assert.rejects(
    runPartnerAssist(input, store, llm),
    (err: unknown) => err instanceof PartnerAssistInputError && err.code === 422
  );
});

test('LLM que lanza → PartnerAssistLlmError (502 en server.ts) [INV-KL6]', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const llm = new ScriptedLlm([new Error('ECONNREFUSED: LLM caído')]);

  const input: PartnerAssistInput = {
    mode: 'reorganize',
    partner_id: TEST_PARTNER_ID,
    markdown: VALID_CONCEPT_MARKDOWN,
  };

  await assert.rejects(
    runPartnerAssist(input, store, llm),
    (err: unknown) => err instanceof PartnerAssistLlmError && err.code === 502
  );
});

test('[INV-KL3] partner-assist.ts nunca invoca BundleStore.write (no persiste nada)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'partner-assist.ts'), 'utf-8');
  assert.equal(/\.write\(/.test(src), false, 'partner-assist.ts no debe llamar a ningún método .write(...)');
});

test('draft_from_source: lee material de _fuentes/ y cita solo esas refs', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  const rawContent = 'Documento fuente: la politica de reembolsos exige aprobacion del gerente regional.';
  const sha256 = createHash('sha256').update(Buffer.from(rawContent, 'utf8')).digest('hex');
  const gcsObject = `_fuentes/${sha256}.txt`;
  // KL2-W1 (source-upload.ts): el objeto se guarda con el content_base64 TAL CUAL.
  await storage.save(gcsObject, Buffer.from(rawContent, 'utf8').toString('base64'));

  const draftOutput = VALID_CONCEPT_MARKDOWN.replace(
    'sources: ["conv:thread-123"]',
    `sources: ["doc:sha256:${sha256}"]`
  );
  const llm = new ScriptedLlm([draftOutput]);

  const input: PartnerAssistInput = {
    mode: 'draft_from_source',
    partner_id: TEST_PARTNER_ID,
    source_gcs_objects: [gcsObject],
    concept_type: 'Politica',
    system: 'l-legal',
  };

  const result = await runPartnerAssist(input, store, llm);

  assert.equal(result.stripped_refs.length, 0);
  assert.equal(result.markdown.includes(`doc:sha256:${sha256}`), true);
});

test('draft_from_source con ref inventada por el LLM → se elimina y aparece en stripped_refs', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  const rawContent = 'Documento fuente legitimo.';
  const sha256 = createHash('sha256').update(Buffer.from(rawContent, 'utf8')).digest('hex');
  const gcsObject = `_fuentes/${sha256}.txt`;
  await storage.save(gcsObject, Buffer.from(rawContent, 'utf8').toString('base64'));

  const draftOutput = VALID_CONCEPT_MARKDOWN.replace(
    'sources: ["conv:thread-123"]',
    `sources: ["doc:sha256:${sha256}", "url:https://no-provista.example.com"]`
  );
  const llm = new ScriptedLlm([draftOutput]);

  const input: PartnerAssistInput = {
    mode: 'draft_from_source',
    partner_id: TEST_PARTNER_ID,
    source_gcs_objects: [gcsObject],
  };

  const result = await runPartnerAssist(input, store, llm);

  assert.deepEqual(result.stripped_refs, ['url:https://no-provista.example.com']);
  assert.equal(result.markdown.includes(`doc:sha256:${sha256}`), true);
  assert.equal(result.markdown.includes('no-provista.example.com'), false);
});

test('draft_from_source sin source_gcs_objects → PartnerAssistInputError (422)', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const llm = new ScriptedLlm([VALID_CONCEPT_MARKDOWN]);

  const input: PartnerAssistInput = {
    mode: 'draft_from_source',
    partner_id: TEST_PARTNER_ID,
  };

  await assert.rejects(
    runPartnerAssist(input, store, llm),
    (err: unknown) => err instanceof PartnerAssistInputError
  );
});

test('reorganize sin markdown → PartnerAssistInputError (422)', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const llm = new ScriptedLlm([VALID_CONCEPT_MARKDOWN]);

  const input: PartnerAssistInput = {
    mode: 'reorganize',
    partner_id: TEST_PARTNER_ID,
  };

  await assert.rejects(
    runPartnerAssist(input, store, llm),
    (err: unknown) => err instanceof PartnerAssistInputError
  );
});
