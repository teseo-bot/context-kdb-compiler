/**
 * PA2-W4: Tests dirigidos del publisher firmado de paquetes de aliado.
 *
 * Scope (tests pedidos por la WU):
 *  (a) publish de 3 conceptos → 3 filas en okf_partner_concepts + manifest verificable con
 *      verifyManifest → 'verified' [INV-3.4].
 *  (b) segundo publish v2 con 1 concepto menos → el índice queda EXACTAMENTE con los de v2.
 *  (c) draft con frontmatter roto (curator incompleto) → 422 + 0 cambios en índice y bundle
 *      [INV-3.1][INV-KL2].
 *  (d) cadena rota (log alterado) → 409 [INV-3.3].
 * Extra: draft_path inexistente → 404 (cubre PartnerDraftsNotFoundError, no listado
 * explícitamente por la WU pero parte del contrato de la ruta).
 *
 * GCS simulado: mismo patrón in-memory que bundle-store.test.ts / partner-ingest.test.ts.
 * Postgres: local 5436 (mismo patrón que indexing/indexer.test.ts) — las migraciones 001-007
 * ya están aplicadas en esa BD (verificado antes de escribir este archivo).
 * Firma: ver `makeFakeSigner` más abajo para el porqué de inyectar `signManifestFn` en vez de
 * un `KmsClient` fake.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, createSign } from 'node:crypto';
import { Pool } from 'pg';
import * as yaml from 'js-yaml';
import {
  BundleStore,
  BundleStorageBackend,
  GenerationMismatchError,
  ReadResult,
  StoredObjectMeta,
} from '../infrastructure/bundle-store';
import { EmbeddingsClient, EMBEDDING_DIM } from '../infrastructure/embeddings';
import { verifyManifest, signManifest } from './signer';
import {
  publishPartnerPackage,
  PartnerPublishInput,
  PartnerPublishChainBrokenError,
  PartnerDraftsNotFoundError,
  PartnerPublishValidationError,
} from './publisher';
import { SignAndPreserve, Constancia, PreservationSubject } from './preservation';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5436/postgres';

// ==================== GCS simulado (mismo patrón que el resto del repo) ====================

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

class MockEmbeddingsClient768 implements EmbeddingsClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const seed = t.length;
      return new Array(EMBEDDING_DIM).fill(0).map((_, i) => (Math.sin(seed + i) + 1) / 2);
    });
  }
}

// ==================== Firma simulada (signManifestFn inyectable) ====================
//
// node:crypto NO expone una primitiva pública de "firma ECDSA cruda sobre un digest ya
// calculado" (verificado empíricamente: `crypto.sign(null, digestBuffer, key)` re-hashea el
// buffer con sha256 en vez de firmarlo tal cual — a diferencia de un KMS real, que sí firma el
// digest recibido sin re-hashear). Un `KmsClient` fake solo recibe el digest (mismo contrato
// que un KMS real), así que no puede producir una firma verificable con `createVerify('sha256')`
// sin re-implementar ECDSA a mano. Por eso el test usa `signManifestFn` (dependencia inyectable
// de publisher.ts, pensada exactamente para esto): un reemplazo de `signManifest` con acceso
// directo al `canonicalJson` real, que firma con `createSign('sha256')` — produciendo una firma
// ECDSA-con-SHA256 estándar, verificable con `verifyManifest` tal cual.
function makeFakeSigner(): { publicKey: string; signManifestFn: typeof signManifest } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const signManifestFn: typeof signManifest = async (canonicalJson: string) => {
    const digest = require('node:crypto').createHash('sha256').update(canonicalJson, 'utf-8').digest();
    const signer = createSign('sha256');
    signer.update(canonicalJson, 'utf-8');
    const signatureB64 = signer.sign(privateKey, 'base64');
    return {
      manifest_sha256: digest.toString('hex'),
      signature_b64: signatureB64,
      kms_key_version: 'projects/test/locations/us-central1/keyRings/kdb-partners-test/cryptoKeys/partner-test/cryptoKeyVersions/1',
    };
  };

  return { publicKey, signManifestFn };
}

// ==================== Fixtures ====================

function conceptMarkdown(opts: {
  title: string;
  description: string;
  body: string;
  tags?: string[];
  sources?: string[];
  altitude?: number;
  curator?: { legal_name: string; responsible: string };
}): string {
  const fm: Record<string, unknown> = {
    type: 'Insight',
    title: opts.title,
    description: opts.description,
    tags: opts.tags ?? ['l-legal', 'contratos'],
    timestamp: '2026-07-08T10:00:00Z',
    sources: opts.sources ?? ['conv:demo-thread-1'],
    confidence: 'draft', // el publish es el acto de aprobación; siempre 'draft' en _staging/
    pii: 'clean',
    altitude: opts.altitude ?? 2,
    curator: opts.curator ?? { legal_name: 'Bufete Demo & Asociados', responsible: 'Jane Doe' },
  };
  const yamlStr = yaml.dump(fm, { schema: yaml.JSON_SCHEMA });
  return `---\n${yamlStr}---\n\n${opts.body}`;
}

let pool: Pool;
const TEST_PARTNER_ID = randomUUID();
const PARTNER_SLUG = 'bufete-demo-test';
const ALL_PACKAGE_IDS: string[] = [];

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  if (!process.env.KMS_PARTNER_KEYRING) {
    process.env.KMS_PARTNER_KEYRING = 'projects/test/locations/us-central1/keyRings/kdb-partners-test';
  }
});

after(async () => {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM okf_partner_edges WHERE package_id = ANY($1::uuid[])', [ALL_PACKAGE_IDS]);
    await client.query('DELETE FROM okf_partner_concepts WHERE package_id = ANY($1::uuid[])', [ALL_PACKAGE_IDS]);
  } finally {
    client.release();
  }
  await pool.end();
});

// ==================== Tests ====================

test("PA2-W4 (a): publish de 3 conceptos → 3 filas en okf_partner_concepts + manifest verificable con verifyManifest → 'verified' [INV-3.4]", async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const packageId = randomUUID();
  ALL_PACKAGE_IDS.push(packageId);
  const packageSlug = 'contratos-mercantiles-a';

  const draftDefs = [
    {
      slug: 'clausula-limitacion',
      title: 'Cláusula de Limitación de Responsabilidad',
      description: 'Modelo de cláusula de limitación de responsabilidad para contratos mercantiles.',
      body: 'Cuerpo de la cláusula de limitación. Ver también [Confidencialidad](/clausula-confidencialidad.md).',
    },
    {
      slug: 'clausula-confidencialidad',
      title: 'Cláusula de Confidencialidad',
      description: 'Modelo de cláusula de confidencialidad estándar para contratos mercantiles.',
      body: 'Cuerpo de la cláusula de confidencialidad.',
    },
    {
      slug: 'clausula-terminacion',
      title: 'Cláusula de Terminación Anticipada',
      description: 'Modelo de cláusula de terminación anticipada del contrato mercantil.',
      body: 'Cuerpo de la cláusula de terminación anticipada.',
    },
  ];

  const draftPaths: string[] = [];
  for (const d of draftDefs) {
    const path = `_staging/2026-07-08/${d.slug}.md`;
    await store.write(path, conceptMarkdown(d), { actor: 'test', accion: 'draft' });
    draftPaths.push(path);
  }

  const { publicKey, signManifestFn } = makeFakeSigner();
  const embeddings = new MockEmbeddingsClient768();

  {
    const input: PartnerPublishInput = {
      partner_id: TEST_PARTNER_ID,
      partner_slug: PARTNER_SLUG,
      package_id: packageId,
      package_slug: packageSlug,
      version: 1,
      draft_paths: draftPaths,
    };

    const result = await publishPartnerPackage(input, { pool, embeddings, store, signManifestFn });

    assert.equal(result.manifest.concepts.length, 3, 'manifest tiene 3 conceptos');
    assert.equal(result.manifest.package_id, packageId);
    assert.equal(result.manifest.package_slug, packageSlug);
    assert.equal(result.manifest.version, 1);
    assert.ok(
      result.manifest.concepts.every((c) => c.path.startsWith(`@${PARTNER_SLUG}/l-legal/`)),
      'paths lógicos con la forma @{partner_slug}/{system}/{slug}.md'
    );

    const verification = verifyManifest(result.manifest as any, publicKey);
    assert.equal(verification, 'verified', 'manifest firmado debe verificar [INV-3.4]');

    const rows = await pool.query(
      'SELECT path, system_slug, altitude, embedding IS NOT NULL AS has_embedding, gcs_path FROM okf_partner_concepts WHERE package_id = $1 ORDER BY path',
      [packageId]
    );
    assert.equal(rows.rows.length, 3, '3 filas en okf_partner_concepts');
    for (const row of rows.rows) {
      assert.equal(row.system_slug, 'l-legal');
      assert.equal(row.has_embedding, true);
      assert.ok(row.gcs_path.startsWith(`paquetes/${packageSlug}/`));
    }

    const edges = await pool.query(
      'SELECT from_path, to_path, origin FROM okf_partner_edges WHERE package_id = $1',
      [packageId]
    );
    assert.equal(edges.rows.length, 1, '1 arista intra-paquete desde el cross-link');
    assert.equal(edges.rows[0].from_path, `@${PARTNER_SLUG}/l-legal/clausula-limitacion.md`);
    assert.equal(edges.rows[0].to_path, `@${PARTNER_SLUG}/l-legal/clausula-confidencialidad.md`);
    // ADR-210 D-210.13 — decisión deliberada, no un descuido: en el plano de aliados
    // `confidence` no lleva información (todo draft se fuerza a 'draft' y el publish promueve
    // todo a 'reviewed'), así que derivar la marca de ahí sellaría EXTRACTED cada arista por
    // el mero hecho de publicar. Se marca la que NO sobre-afirma hasta que el flujo de
    // curaduría gane una afirmación real por-arista. Ver PARTNER_EDGE_ORIGIN en publisher.ts.
    assert.equal(
      edges.rows[0].origin,
      'INFERRED',
      'una arista de paquete no puede presentarse como extraída sin que un curador lo afirme'
    );

    const written = await store.read(`paquetes/${packageSlug}/clausula-limitacion.md`);
    assert.ok(written, 'concepto escrito en paquetes/{slug}/');
    assert.ok(written!.content.includes('confidence: reviewed'), 'confidence forzado a reviewed');

    const indexMd = await store.read(`paquetes/${packageSlug}/index.md`);
    assert.ok(indexMd, 'portada del paquete escrita');
    assert.ok(indexMd!.content.includes('okf_version'), 'frontmatter okf_version en la portada (TRD §6)');
    assert.ok(indexMd!.content.includes('Cláusula de Confidencialidad'), 'portada lista títulos de conceptos');

    const manifestFile = await store.read(`paquetes/${packageSlug}/manifest.json`);
    assert.ok(manifestFile, 'manifest.json escrito al bundle');

    // El draft original NO se borra de _staging/ (BundleStore no expone delete — ver
    // cabecera de publisher.ts): desviación documentada, no un bug de este test.
    const draftStillThere = await store.read(draftPaths[0]);
    assert.ok(draftStillThere, 'draft sigue en _staging/ (BundleStore no borra)');
  }
});

test('PA2-W4 (b): segundo publish v2 con 1 concepto menos → el índice queda EXACTAMENTE con los de v2', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const packageId = randomUUID();
  ALL_PACKAGE_IDS.push(packageId);
  const packageSlug = 'contratos-mercantiles-b';

  const draftDefs = [
    { slug: 'concepto-uno', title: 'Concepto Uno', description: 'Primer concepto de prueba.', body: 'Cuerpo uno.' },
    { slug: 'concepto-dos', title: 'Concepto Dos', description: 'Segundo concepto de prueba.', body: 'Cuerpo dos.' },
    { slug: 'concepto-tres', title: 'Concepto Tres', description: 'Tercer concepto de prueba.', body: 'Cuerpo tres.' },
  ];
  const draftPaths: string[] = [];
  for (const d of draftDefs) {
    const path = `_staging/2026-07-08/${d.slug}.md`;
    await store.write(path, conceptMarkdown(d), { actor: 'test', accion: 'draft' });
    draftPaths.push(path);
  }

  const embeddings = new MockEmbeddingsClient768();

  {
    const { signManifestFn } = makeFakeSigner();
    const inputV1: PartnerPublishInput = {
      partner_id: TEST_PARTNER_ID,
      partner_slug: PARTNER_SLUG,
      package_id: packageId,
      package_slug: packageSlug,
      version: 1,
      draft_paths: draftPaths,
    };
    const resultV1 = await publishPartnerPackage(inputV1, { pool, embeddings, store, signManifestFn });
    assert.equal(resultV1.manifest.concepts.length, 3);
  }

  const rowsV1 = await pool.query('SELECT path FROM okf_partner_concepts WHERE package_id = $1', [packageId]);
  assert.equal(rowsV1.rows.length, 3, 'v1 publicó 3 conceptos');

  // v2: solo 2 de los 3 draft_paths (siguen disponibles en _staging/, BundleStore no borra).
  {
    const { signManifestFn } = makeFakeSigner();
    const inputV2: PartnerPublishInput = {
      partner_id: TEST_PARTNER_ID,
      partner_slug: PARTNER_SLUG,
      package_id: packageId,
      package_slug: packageSlug,
      version: 2,
      draft_paths: draftPaths.slice(0, 2),
    };
    const resultV2 = await publishPartnerPackage(inputV2, { pool, embeddings, store, signManifestFn });
    assert.equal(resultV2.manifest.concepts.length, 2, 'manifest v2 tiene 2 conceptos');
    assert.equal(resultV2.manifest.version, 2);

    const rowsV2 = await pool.query(
      'SELECT path FROM okf_partner_concepts WHERE package_id = $1 ORDER BY path',
      [packageId]
    );
    assert.equal(rowsV2.rows.length, 2, 'índice queda EXACTAMENTE con los 2 conceptos de v2');

    const expectedPaths = [
      `@${PARTNER_SLUG}/l-legal/concepto-uno.md`,
      `@${PARTNER_SLUG}/l-legal/concepto-dos.md`,
    ].sort();
    assert.deepEqual(
      rowsV2.rows.map((r: any) => r.path).sort(),
      expectedPaths,
      'concepto-tres.md (solo en v1) ya no está en el índice'
    );
  }
});

test('PA2-W4 (c): draft con frontmatter roto (curator incompleto) → 422 + 0 cambios en índice y bundle [INV-3.1][INV-KL2]', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const packageId = randomUUID();
  ALL_PACKAGE_IDS.push(packageId);
  const packageSlug = 'contratos-mercantiles-c';

  const goodDraftPath = '_staging/2026-07-08/concepto-bueno.md';
  await store.write(
    goodDraftPath,
    conceptMarkdown({ title: 'Concepto Bueno', description: 'Un concepto válido.', body: 'Cuerpo válido.' }),
    { actor: 'test', accion: 'draft' }
  );

  // curator incompleto (falta "responsible") → n3-curator
  const brokenDraftPath = '_staging/2026-07-08/concepto-roto.md';
  const brokenMarkdown = `---
type: Insight
title: Concepto Roto
description: Descripcion del concepto roto
tags:
  - l-legal
  - contratos
timestamp: 2026-07-08T10:00:00Z
sources:
  - conv:demo-thread-1
confidence: draft
pii: clean
altitude: 2
curator:
  legal_name: Bufete Demo & Asociados
---

Cuerpo del concepto roto (falta curator.responsible).`;
  await store.write(brokenDraftPath, brokenMarkdown, { actor: 'test', accion: 'draft' });

  const { signManifestFn } = makeFakeSigner();
  const embeddings = new MockEmbeddingsClient768();

  const input: PartnerPublishInput = {
    partner_id: TEST_PARTNER_ID,
    partner_slug: PARTNER_SLUG,
    package_id: packageId,
    package_slug: packageSlug,
    version: 1,
    draft_paths: [goodDraftPath, brokenDraftPath],
  };

  try {
    await publishPartnerPackage(input, { pool, embeddings, store, signManifestFn });
    assert.fail('Se esperaba PartnerPublishValidationError');
  } catch (error: any) {
    assert.ok(error instanceof PartnerPublishValidationError, 'lanza PartnerPublishValidationError (→ 422)');
    assert.ok(
      error.reports.some((r: any) => r.findings.some((f: any) => f.rule_id === 'n3-curator')),
      'el reporte incluye el finding n3-curator'
    );
  }

  const rows = await pool.query(
    'SELECT COUNT(*)::int AS count FROM okf_partner_concepts WHERE package_id = $1',
    [packageId]
  );
  assert.equal(rows.rows[0].count, 0, '0 filas en el índice — nada se publicó [INV-3.1]');

  const writtenGood = await store.read(`paquetes/${packageSlug}/concepto-bueno.md`);
  assert.equal(writtenGood, null, 'el concepto VÁLIDO tampoco se escribió — atomicidad del batch');

  const manifestFile = await store.read(`paquetes/${packageSlug}/manifest.json`);
  assert.equal(manifestFile, null, 'no se generó manifest');
});

test('PA2-W4 (d): cadena rota (log alterado) → 409 [INV-3.3]', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const packageId = randomUUID();
  ALL_PACKAGE_IDS.push(packageId);
  const packageSlug = 'contratos-mercantiles-d';

  const draftPath = '_staging/2026-07-08/concepto-x.md';
  await store.write(
    draftPath,
    conceptMarkdown({ title: 'Concepto X', description: 'Un concepto cualquiera.', body: 'Cuerpo x.' }),
    { actor: 'test', accion: 'draft' }
  );

  // Corromper el log directamente (mismo patrón que partner-bundle-store.test.ts).
  const logVersions = storage.versions.get('log.md')!;
  const latest = logVersions[logVersions.length - 1];
  const lines = latest.content.split('\n').filter((l) => l.length > 0);
  const corrupted = lines.map((l, i) => (i === 0 ? l.replace('genesis', 'fake') : l)).join('\n') + '\n';
  logVersions[logVersions.length - 1] = { content: corrupted, generation: latest.generation };

  const { signManifestFn } = makeFakeSigner();
  const embeddings = new MockEmbeddingsClient768();

  const input: PartnerPublishInput = {
    partner_id: TEST_PARTNER_ID,
    partner_slug: PARTNER_SLUG,
    package_id: packageId,
    package_slug: packageSlug,
    version: 1,
    draft_paths: [draftPath],
  };

  try {
    await publishPartnerPackage(input, { pool, embeddings, store, signManifestFn });
    assert.fail('Se esperaba PartnerPublishChainBrokenError');
  } catch (error: any) {
    assert.ok(error instanceof PartnerPublishChainBrokenError, 'lanza PartnerPublishChainBrokenError (→ 409)');
  }

  const rows = await pool.query(
    'SELECT COUNT(*)::int AS count FROM okf_partner_concepts WHERE package_id = $1',
    [packageId]
  );
  assert.equal(rows.rows[0].count, 0, '0 filas — abortó antes de cualquier escritura');
});

test('PA2-W4 (extra): draft_path inexistente en _staging/ → 404', async () => {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const packageId = randomUUID();
  ALL_PACKAGE_IDS.push(packageId);
  const packageSlug = 'contratos-mercantiles-e';

  const existingPath = '_staging/2026-07-08/existe.md';
  await store.write(
    existingPath,
    conceptMarkdown({ title: 'Existe', description: 'Un concepto que sí existe.', body: 'Cuerpo.' }),
    { actor: 'test', accion: 'draft' }
  );

  const { signManifestFn } = makeFakeSigner();
  const embeddings = new MockEmbeddingsClient768();

  const input: PartnerPublishInput = {
    partner_id: TEST_PARTNER_ID,
    partner_slug: PARTNER_SLUG,
    package_id: packageId,
    package_slug: packageSlug,
    version: 1,
    draft_paths: [existingPath, '_staging/2026-07-08/no-existe.md'],
  };

  try {
    await publishPartnerPackage(input, { pool, embeddings, store, signManifestFn });
    assert.fail('Se esperaba PartnerDraftsNotFoundError');
  } catch (error: any) {
    assert.ok(error instanceof PartnerDraftsNotFoundError, 'lanza PartnerDraftsNotFoundError (→ 404)');
    assert.deepEqual(error.missing, ['_staging/2026-07-08/no-existe.md']);
  }

  const rows = await pool.query(
    'SELECT COUNT(*)::int AS count FROM okf_partner_concepts WHERE package_id = $1',
    [packageId]
  );
  assert.equal(rows.rows[0].count, 0);
});

// ==================== NOM-151 (capa D) — cableo gated default-off ====================
//
// Prueban SOLO el enganche del seam en el publisher (que el seam en sí funcione lo prueba
// preservation.test.ts). Preserver inyectado (fake `SignAndPreserve`) para no depender de KMS.

/** Publica un solo concepto y devuelve el store, para no repetir el setup en cada test. */
async function publishOne(
  packageSlug: string,
  extraDeps: { preserver?: SignAndPreserve }
): Promise<{ store: BundleStore; packageSlug: string }> {
  const storage = new InMemoryStorageBackend();
  const store = new BundleStore({ tenantId: TEST_PARTNER_ID, storage });
  const packageId = randomUUID();
  ALL_PACKAGE_IDS.push(packageId);

  const draftPath = '_staging/2026-07-08/concepto-nom151.md';
  await store.write(
    draftPath,
    conceptMarkdown({ title: 'Concepto NOM-151', description: 'Concepto de prueba para el cableo de la constancia.', body: 'Cuerpo.' }),
    { actor: 'test', accion: 'draft' }
  );

  const { signManifestFn } = makeFakeSigner();
  const embeddings = new MockEmbeddingsClient768();
  const input: PartnerPublishInput = {
    partner_id: TEST_PARTNER_ID,
    partner_slug: PARTNER_SLUG,
    package_id: packageId,
    package_slug: packageSlug,
    version: 1,
    draft_paths: [draftPath],
  };
  await publishPartnerPackage(input, { pool, embeddings, store, signManifestFn, ...extraDeps });
  return { store, packageSlug };
}

test('NOM-151 (gated): sin NOM151_PRESERVE, el publish NO escribe constancia.json (default-off)', async () => {
  const prev = process.env.NOM151_PRESERVE;
  delete process.env.NOM151_PRESERVE;
  try {
    const { store, packageSlug } = await publishOne('contratos-nom151-off', {});
    const constancia = await store.read(`paquetes/${packageSlug}/constancia.json`);
    assert.equal(constancia, null, 'default-off: no se emite constancia en el path vivo');
  } finally {
    if (prev !== undefined) process.env.NOM151_PRESERVE = prev;
  }
});

test('NOM-151 (gated): con NOM151_PRESERVE=on, el publish escribe constancia.json sobre el manifiesto firmado', async () => {
  const prev = process.env.NOM151_PRESERVE;
  process.env.NOM151_PRESERVE = 'on';

  // Fake preserver: captura el subject y emite una constancia marcada, sin KMS.
  let captured: PreservationSubject | undefined;
  const fakePreserver: SignAndPreserve = {
    provider: 'kms-timestamp',
    legalGrade: 'technical',
    async preserve(subject) {
      captured = subject;
      const c: Constancia = {
        constancia_version: '1',
        message_sha256: subject.message_sha256,
        subject_ref: subject.ref,
        timestamp: '2026-07-23T18:00:00.000Z',
        timestamp_source: 'kms-server',
        provider: 'kms-timestamp',
        legal_grade: 'technical',
        proof: { type: 'kms-ecdsa-p256', value_b64: 'ZmFrZQ==' },
        issuer: 'test-key-version',
      };
      return c;
    },
    async verify() {
      return { status: 'verified' };
    },
  };

  try {
    const { store, packageSlug } = await publishOne('contratos-nom151-on', { preserver: fakePreserver });

    const file = await store.read(`paquetes/${packageSlug}/constancia.json`);
    assert.ok(file, 'con el flag on se escribe constancia.json junto al manifiesto');
    const c = JSON.parse(file!.content) as Constancia;
    assert.equal(c.constancia_version, '1');
    assert.equal(c.legal_grade, 'technical');
    assert.equal(c.subject_ref, `partner:${PARTNER_SLUG}/package:${packageSlug}/v1`);

    // La constancia sella el MISMO hash que firma el manifiesto (capa D complementa capa A).
    const manifestFile = await store.read(`paquetes/${packageSlug}/manifest.json`);
    const manifest = JSON.parse(manifestFile!.content);
    assert.equal(captured?.message_sha256, manifest.manifest_sha256, 'se conserva el manifest_sha256 firmado');
    assert.equal(c.message_sha256, manifest.manifest_sha256);
  } finally {
    if (prev === undefined) delete process.env.NOM151_PRESERVE;
    else process.env.NOM151_PRESERVE = prev;
  }
});
