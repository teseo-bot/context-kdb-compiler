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

// /internal/distill-candidates — contrato de la ruta (auth y validación de entrada). El
// comportamiento de runV2 en sí ya está cubierto contra Postgres en
// src/ingestion/candidate-poller.test.ts; aquí solo se verifica que la ruta no deje pasar una
// llamada sin credencial ni sin tenantId, porque destilar escribe en el bundle del tenant.

test('POST /internal/distill-candidates sin x-api-key → 401', async () => {
  const res = await app.request('/internal/distill-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId: 'tenant-de-prueba' }),
  });
  assert.equal(res.status, 401);
});

test('POST /internal/distill-candidates con x-api-key incorrecto → 401', async () => {
  const res = await app.request('/internal/distill-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'llave-incorrecta' },
    body: JSON.stringify({ tenantId: 'tenant-de-prueba' }),
  });
  assert.equal(res.status, 401);
});

test('POST /internal/distill-candidates sin tenantId → 422, sin tocar la BD', async () => {
  const res = await app.request('/internal/distill-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, 'Validation Failed');
});

// Integración contra el Postgres local (docker-compose: pgvector/pgvector:pg16 en :5436, con las
// migraciones aplicadas), mismo patrón que candidate-poller.test.ts. Siembra candidates mockup y
// ejercita la RUTA, no runV2 directamente: es lo único que prueba que el cableado del servidor
// (pool, BundleStore y LLMs simulados bajo NODE_ENV==='test') está bien hecho. En producción no
// hay candidates que destilar, así que sembrar es la única forma de correr esto.
const DISTILL_TENANT = 'test-distill-route';

test('POST /internal/distill-candidates destila los candidates sembrados → 200 {drafted}', async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });

  async function limpiar() {
    await pool.query('DELETE FROM knowledge_candidates WHERE tenant_id = $1', [DISTILL_TENANT]);
    await pool.query('DELETE FROM okf_provenance WHERE tenant_id = $1', [DISTILL_TENANT]);
    await pool.query('DELETE FROM okf_concepts WHERE tenant_id = $1', [DISTILL_TENANT]);
  }

  try {
    await limpiar();
    for (const ref of ['conv:mockup-uno', 'conv:mockup-dos']) {
      await pool.query(
        `INSERT INTO knowledge_candidates (tenant_id, kind, source_ref, payload_summary, status)
         VALUES ($1, 'conversation_closed', $2, $3, 'pending')`,
        [DISTILL_TENANT, ref, `resumen mockup para ${ref}`]
      );
    }

    const res = await app.request('/internal/distill-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
      body: JSON.stringify({ tenantId: DISTILL_TENANT }),
    });

    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.drafted, 2, 'los dos candidates sembrados deberían quedar drafted');
    assert.equal(result.errors, 0);

    const pendientes = await pool.query(
      `SELECT count(*)::int AS n FROM knowledge_candidates WHERE tenant_id = $1 AND status = 'pending'`,
      [DISTILL_TENANT]
    );
    assert.equal(pendientes.rows[0].n, 0, 'no debería quedar ningún candidate pending');

    // Segunda corrida: idempotente, ya no hay nada pendiente que reclamar.
    const res2 = await app.request('/internal/distill-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': M2M_API_KEY },
      body: JSON.stringify({ tenantId: DISTILL_TENANT }),
    });
    assert.equal(res2.status, 200);
    // `discovered` viaja siempre en la respuesta: el paso 0 dejó de estar detrás de
    // `opts.supabase`. Este tenant no siembra documentos, así que descubre 0.
    assert.deepEqual(await res2.json(), { drafted: 0, discarded: 0, errors: 0, discovered: { documents: 0 } });
  } finally {
    await limpiar();
    await pool.end();
  }
});
