// KL0-W3 — tests de /internal/partner-validate (PLAN-KnowledgeLab-Epicas-KL.md, KL0-W3).
//
// Requiere NODE_ENV=test (mismo patrón que el resto del repo: CompilerEngine/embeddings usan
// mocks solo bajo NODE_ENV==='test'; aquí además evita que `serve()` levante un listener TCP
// real al importar `app` desde server.ts — ver el guard agregado en server.ts).
//
// El caso "package_slug resuelve vía okf_partner_concepts" es un test de integración contra
// Postgres local (mismo patrón que src/indexing/indexer.test.ts): siembra una fila y la borra
// al final.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { app } from './server';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';
const M2M_API_KEY = 'test-m2m-key-kl0w3';

before(() => {
  process.env.M2M_API_KEY = M2M_API_KEY;
});

const VALID_MARKDOWN = `---
type: Insight
title: Concepto válido de prueba
description: Usado por server.test.ts para KL0-W3.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'a'.repeat(64)}]
confidence: consolidated
pii: clean
altitude: 1
curator:
  legal_name: Bufete Demo S.C.
  responsible: Ana Ramírez
---

Cuerpo de prueba sin cross-links.
`;

const INVALID_MARKDOWN = `---
title: Sin type
description: Falta el campo type.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'b'.repeat(64)}]
confidence: draft
pii: clean
altitude: 1
---

Cuerpo de prueba.
`;

test('POST /internal/partner-validate sin x-api-key → 401', async () => {
  const res = await app.request('/internal/partner-validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: VALID_MARKDOWN, partner_id: randomUUID() }),
  });
  assert.equal(res.status, 401);
});

test('POST /internal/partner-validate con x-api-key incorrecto → 401', async () => {
  const res = await app.request('/internal/partner-validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'llave-incorrecta' },
    body: JSON.stringify({ markdown: VALID_MARKDOWN, partner_id: randomUUID() }),
  });
  assert.equal(res.status, 401);
});

test('POST /internal/partner-validate con concepto válido → 200 {valid:true}, cero escrituras', async () => {
  const res = await app.request('/internal/partner-validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
    body: JSON.stringify({
      markdown: VALID_MARKDOWN,
      partner_id: randomUUID(),
      for_publish: true,
      package_paths: [],
    }),
  });
  assert.equal(res.status, 200);
  const report = await res.json();
  assert.equal(report.valid, true);
  assert.deepEqual(report.findings, []);
});

test('POST /internal/partner-validate con concepto inválido (sin type) → 200 {valid:false, findings:[...]}', async () => {
  const res = await app.request('/internal/partner-validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
    body: JSON.stringify({
      markdown: INVALID_MARKDOWN,
      partner_id: randomUUID(),
      package_paths: [],
    }),
  });
  assert.equal(res.status, 200);
  const report = await res.json();
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f: any) => f.rule_id === 'n1-type-requerido'));
});

test('POST /internal/partner-validate con body inválido (falta partner_id) → 422', async () => {
  const res = await app.request('/internal/partner-validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
    body: JSON.stringify({ markdown: VALID_MARKDOWN }),
  });
  assert.equal(res.status, 422);
});

test('POST /internal/partner-validate con package_slug que NO es UUID y sin package_paths → 501 explícito (no inventa el join slug→package_id)', async () => {
  const res = await app.request('/internal/partner-validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
    body: JSON.stringify({
      markdown: VALID_MARKDOWN,
      partner_id: randomUUID(),
      package_slug: 'bufete-demo', // slug real, no UUID: no hay columna package_slug en okf_partner_concepts
    }),
  });
  assert.equal(res.status, 501);
});

// --- integración con Postgres: package_slug (== package_id UUID) resuelve packagePaths -------

test('POST /internal/partner-validate con package_slug=package_id (UUID) → resuelve packagePaths desde okf_partner_concepts', async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const partnerId = randomUUID();
  const packageId = randomUUID();
  const seededPath = '/c-comercial/otro-concepto.md';

  try {
    await pool.query(
      `INSERT INTO okf_partner_concepts
        (partner_id, package_id, version, path, gcs_path, frontmatter, body_text, content_sha256, altitude, system_slug)
       VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, 1, 'c-comercial')`,
      [
        partnerId,
        packageId,
        seededPath,
        `kdb-partner-${partnerId}/${seededPath}`,
        JSON.stringify({ type: 'Insight' }),
        'cuerpo de prueba',
        'f'.repeat(64),
      ]
    );

    const markdownWithLink = `---
type: Insight
title: Con link al concepto sembrado
description: El link debe resolverse contra packagePaths cargados de okf_partner_concepts.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'c'.repeat(64)}]
confidence: consolidated
pii: clean
altitude: 1
curator:
  legal_name: Bufete Demo S.C.
  responsible: Ana Ramírez
---

Ver [otro concepto](${seededPath}).
`;

    const res = await app.request('/internal/partner-validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
      body: JSON.stringify({
        markdown: markdownWithLink,
        partner_id: partnerId,
        package_slug: packageId, // interpretado como package_id (ver comentario en server.ts)
        for_publish: true,
      }),
    });

    assert.equal(res.status, 200);
    const report = await res.json();
    assert.equal(
      report.findings.some((f: any) => f.rule_id === 'n3-link-pendiente' || f.rule_id === 'n3-link-externo'),
      false,
      'el link al path sembrado no debería marcarse como pendiente/externo'
    );
  } finally {
    await pool.query('DELETE FROM okf_partner_concepts WHERE partner_id = $1 AND package_id = $2', [partnerId, packageId]);
    await pool.end();
  }
});
