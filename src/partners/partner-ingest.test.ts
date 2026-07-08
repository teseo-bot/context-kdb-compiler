/**
 * PA2-W3: Tests dirigidos para ingesta y curaduría de drafts de aliado
 *
 * Scope:
 *  1. Doc con email/teléfono → draft escrito con pii:'redacted' [INV-2.1]
 *  2. draft-update con curator incompleto → 422 y CERO escrituras [INV-2.3]
 *  3. draft-update con draft_path fuera de _staging/ → 422
 *  4. draft-update válido → objeto GCS simulado actualizado + log.md crece
 *
 * LLM: No se simula el LLM del distiller en estos tests (redactor de PII es determinista).
 * Los tests usan mocks para PiiLlm y reutilizan el distiller real si es necesario.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BundleStore, BundleStorageBackend, GenerationMismatchError, ReadResult, StoredObjectMeta } from '../infrastructure/bundle-store';
import { ingestPartnerDocument, PartnerIngestInput } from './partner-ingest';
import { updatePartnerDraft, DraftUpdateInput } from './partner-draft-update';
import { PiiLlm } from '../ingestion/pii-redactor';

// ==================== GCS simulado ====================

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
    for (const [path, list] of this.versions.entries()) {
      if (path.startsWith(prefix) && list.length > 0) {
        out.push({ path, generation: list[list.length - 1].generation });
      }
    }
    return out;
  }

  async save(
    path: string,
    content: string,
    opts?: { ifGenerationMatch?: bigint }
  ): Promise<bigint> {
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

// ==================== Mock del LLM de PII ====================

class MockPiiLlm implements PiiLlm {
  async detectSpans(text: string) {
    // Detecta patrones simples sin LLM: emails y números que parecen teléfonos
    const spans: any[] = [];

    // Emails
    const emailRegex = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
    let match;
    while ((match = emailRegex.exec(text)) !== null) {
      spans.push({ start: match.index, end: match.index + match[0].length, type: 'PERSONA' });
    }

    // Teléfonos (10 dígitos)
    const phoneRegex = /\b\d{10}\b/g;
    while ((match = phoneRegex.exec(text)) !== null) {
      spans.push({ start: match.index, end: match.index + match[0].length, type: 'PERSONA' });
    }

    return spans;
  }
}

// ==================== Tests ====================

const TEST_PARTNER_ID = '550e8400-e29b-41d4-a716-446655440001';

test('PA2-W3: doc con email → draft escrito con pii:redacted [INV-2.1]', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  // Documento con email (lo detectará el mock de PII)
  const input: PartnerIngestInput = {
    partner_id: TEST_PARTNER_ID,
    package_slug: 'test-contracts',
    document: {
      filename: 'test.md',
      text: `Contacto: admin@example.com
Este es un documento de prueba sobre cláusulas.`,
    },
  };

  // Mock del LLM del distiller para que devuelva un draft válido CON PII detectada
  class MockDistillerLlm {
    async generate(prompt: string) {
      // Timestamp sin milisegundos (formato ISO8601 válido para el schema)
      const now = new Date().toISOString().split('.')[0] + 'Z';
      return JSON.stringify({
        type: 'Insight',
        title: 'Test Concept with Email',
        description: 'Contact with email admin@example.com',
        tags: ['l-legal', 'test'],
        timestamp: now,
        sources: ['conv:test-thread-123'],
        confidence: 'draft',
        pii: 'clean', // El distiller marca como clean, pero redactor lo cambia a redacted
        altitude: 2,
        body: 'Contact information: admin@example.com for support. Phone: 5551234567',
      });
    }
  }

  const result = await ingestPartnerDocument(input, store, {
    distillerLlm: new MockDistillerLlm() as any,
    piiLlm: new MockPiiLlm(),
  });

  // Verificar que se creó un draft
  assert.equal(result.drafts.length, 1, 'Se crea exactamente 1 draft');

  const draft = result.drafts[0];
  assert.ok(draft.path.startsWith('_staging/'), 'Path comienza con _staging/');
  assert.equal(draft.pii, 'redacted', 'PII debe ser redacted (email detectado)');

  // Verificar que el archivo se escribió a GCS
  const draftContent = storage.versions.get(draft.path);
  assert.ok(draftContent, 'Draft se escribió a GCS');
  assert.ok(draftContent![0].content.includes('[EMAIL_1]'), 'Email fue reemplazado por placeholder [EMAIL_1]');

  // Verificar que log.md se creó (hash-chain)
  const logContent = storage.versions.get('log.md');
  assert.ok(logContent && logContent.length > 0, 'log.md fue creado');
});

test('KL2-W2: ingesta con source_gcs_object → lee el documento de _fuentes/ y produce draft', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  // Simula lo que /internal/partner-source-upload (KL2-W1) ya habría escrito: el objeto en
  // _fuentes/ contiene el base64 del documento tal cual (ver source-upload.ts).
  const docText = 'Cláusula de confidencialidad estándar sin datos personales.';
  const docBase64 = Buffer.from(docText, 'utf8').toString('base64');
  const sourcePath = '_fuentes/deadbeef.txt';
  await store.write(sourcePath, docBase64, { actor: 'partner-source-upload-api', accion: 'draft' });

  class MockDistillerLlm {
    async generate(_prompt: string) {
      const now = new Date().toISOString().split('.')[0] + 'Z';
      return JSON.stringify({
        type: 'Insight',
        title: 'Cláusula desde fuente',
        description: 'Concepto extraído de fuente registrada',
        tags: ['l-legal', 'test'],
        timestamp: now,
        sources: ['conv:test-thread-123'],
        confidence: 'draft',
        pii: 'clean',
        altitude: 2,
        body: docText,
      });
    }
  }

  const result = await ingestPartnerDocument(
    {
      partner_id: TEST_PARTNER_ID,
      package_slug: 'test-contracts',
      source_gcs_object: sourcePath,
    },
    store,
    { distillerLlm: new MockDistillerLlm() as any, piiLlm: new MockPiiLlm() }
  );

  assert.equal(result.drafts.length, 1, 'se crea un draft leyendo desde _fuentes/');
  assert.ok(result.drafts[0].path.startsWith('_staging/'), 'el draft se escribe a _staging/');

  const draftContent = storage.versions.get(result.drafts[0].path);
  assert.ok(draftContent && draftContent[0].content.includes('Cláusula de confidencialidad'), 'el body proviene del documento leído de _fuentes/');
});

test('KL2-W2: ingesta con source_gcs_object inexistente → error explícito, cero drafts', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  await assert.rejects(
    ingestPartnerDocument(
      {
        partner_id: TEST_PARTNER_ID,
        package_slug: 'test-contracts',
        source_gcs_object: '_fuentes/no-existe.pdf',
      },
      store
    ),
    (error: any) => /no encontrado/.test(error.message)
  );
});

test('PA2-W3: draft-update con curator incompleto → 422 y CERO escrituras [INV-2.3]', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  // Primero crear un draft base
  const draftPath = '_staging/2026-07-08/test-concept.md';
  const baseDraft = `---
type: Insight
title: Test Concept
description: A test concept
tags:
  - l-legal
  - test
timestamp: 2026-07-08T10:00:00Z
sources:
  - conv:test-thread-123
confidence: draft
pii: clean
altitude: 2
---

This is a test body`;

  await store.write(draftPath, baseDraft, {
    actor: 'test',
    accion: 'draft',
  });

  // Obtener el hash del log.md inicial
  const initialLogContent = await store.read('log.md');
  const initialLogLines = (initialLogContent?.content || '').split('\n').filter(l => l.length > 0);
  const initialLogCount = initialLogLines.length;

  // Intentar actualizar con curator incompleto (falta responsible)
  const incompleteMarkdown = `---
type: Insight
title: Test Concept Updated
description: A test concept with incomplete curator
tags:
  - l-legal
  - test
timestamp: 2026-07-08T10:00:00Z
sources:
  - conv:test-thread-123
confidence: draft
pii: clean
altitude: 2
curator:
  legal_name: Test Company
---

This is an updated body`;

  try {
    await updatePartnerDraft(
      {
        partner_id: TEST_PARTNER_ID,
        draft_path: draftPath,
        markdown: incompleteMarkdown,
      },
      store
    );
    assert.fail('Expected error for incomplete curator');
  } catch (error: any) {
    assert.equal(error.code, 422, 'Retorna error 422 para curator incompleto');
    assert.ok(error.message.includes('Curator'), 'Error message menciona curator');
  }

  // Verificar que NO se escribió nada nuevo (CERO escrituras)
  const finalLogContent = await store.read('log.md');
  const finalLogLines = (finalLogContent?.content || '').split('\n').filter(l => l.length > 0);
  const finalLogCount = finalLogLines.length;

  assert.equal(finalLogCount, initialLogCount, 'Log.md no creció (no se escribió nada)');
});

test('PA2-W3: draft-update con draft_path fuera de _staging/ → 422', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  const invalidMarkdown = `---
type: Insight
title: Test
description: Test
tags:
  - l-legal
timestamp: 2026-07-08T10:00:00Z
sources:
  - conv:test-thread-123
confidence: draft
pii: clean
altitude: 2
curator:
  legal_name: Test Company
  responsible: Jane Doe
---

Body`;

  // Test 1: path que está en paquetes/ (violación de _staging/)
  try {
    await updatePartnerDraft(
      {
        partner_id: TEST_PARTNER_ID,
        draft_path: 'paquetes/test/concept.md',
        markdown: invalidMarkdown,
      },
      store
    );
    assert.fail('Expected error for path not under _staging/');
  } catch (error: any) {
    assert.equal(error.code, 422, 'Retorna 422 para path fuera de _staging/');
  }

  // Test 2: path con .. (path traversal)
  try {
    await updatePartnerDraft(
      {
        partner_id: TEST_PARTNER_ID,
        draft_path: '_staging/../paquetes/concept.md',
        markdown: invalidMarkdown,
      },
      store
    );
    assert.fail('Expected error for path traversal');
  } catch (error: any) {
    assert.equal(error.code, 422, 'Retorna 422 para path traversal (..)')
    ;
  }
});

test('PA2-W3: draft-update válido → actualización en GCS + log.md crece', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });

  // Crear draft inicial
  const draftPath = '_staging/2026-07-08/test-valid.md';
  const initialDraft = `---
type: Insight
title: Original Title
description: Original description
tags:
  - l-legal
timestamp: 2026-07-08T10:00:00Z
sources:
  - conv:test-thread-123
confidence: draft
pii: clean
altitude: 2
---

Original body`;

  await store.write(draftPath, initialDraft, {
    actor: 'test',
    accion: 'draft',
  });

  // Obtener estado inicial del log
  const initialLog = await store.read('log.md');
  const initialLogLines = (initialLog?.content || '').split('\n').filter(l => l.length > 0);
  const initialLogCount = initialLogLines.length;

  // Actualizar con curator completo
  const updatedMarkdown = `---
type: Insight
title: Updated Title
description: Updated description
tags:
  - l-legal
timestamp: 2026-07-08T10:00:00Z
sources:
  - conv:test-thread-123
confidence: draft
pii: clean
altitude: 3
curator:
  legal_name: Test Legal Company
  responsible: John Doe
---

Updated body with new content`;

  const result = await updatePartnerDraft(
    {
      partner_id: TEST_PARTNER_ID,
      draft_path: draftPath,
      markdown: updatedMarkdown,
    },
    store
  );

  // Verificar resultado
  assert.equal(result.path, draftPath, 'Retorna el path actualizado');
  assert.equal(result.updated, true, 'Marca como actualizado');

  // Verificar que el contenido en GCS fue actualizado
  const draftContent = await store.read(draftPath);
  assert.ok(draftContent, 'Draft sigue en GCS');
  assert.ok(draftContent!.content.includes('Updated Title'), 'Contenido fue actualizado');
  assert.ok(draftContent!.content.includes('Updated body'), 'Body fue actualizado');
  assert.ok(draftContent!.content.includes('John Doe'), 'Curator fue incluido');

  // Verificar que confidence se forzó a 'draft'
  assert.ok(draftContent!.content.includes('confidence: draft'), 'Confidence forzado a draft');

  // Verificar que log.md creció (hash-chain)
  const finalLog = await store.read('log.md');
  const finalLogLines = (finalLog?.content || '').split('\n').filter(l => l.length > 0);
  const finalLogCount = finalLogLines.length;

  assert.ok(finalLogCount > initialLogCount, 'log.md creció (nueva entrada en hash-chain)');
});
