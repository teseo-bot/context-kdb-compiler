#!/usr/bin/env npx tsx

/**
 * PA7-W1: Semilla del aliado demo "Bufete Demo & Asociados"
 *
 * Siembra 12 conceptos sintéticos l-legal en okf_partner_concepts PASANDO POR EL PIPELINE REAL
 * (bundle génesis -> ingesta -> curaduría -> publish firmado -> contrato de licencia de 90 días),
 * SIN NINGÚN INSERT directo al índice [INV-9.1]. `publishPartnerPackage`
 * (src/partners/publisher.ts) es la ÚNICA vía que escribe okf_partner_concepts/okf_partner_edges.
 *
 * El contenido de cada concepto es FIJO (scripts/fixtures/partner-demo-concepts.json), inyectado
 * mediante un `DistillerLlm`/`PiiLlm` deterministas que reemplazan las llamadas reales a Gemini
 * en `distiller-v2`/`pii-redactor` — el resto del pipeline (ingesta, ruteo HOCFLIT, curaduría,
 * validación N3, firma del manifest, indexación) es el código real, sin bypass.
 *
 * La lógica reutilizable vive en `runSeed(deps)`: recibe todas sus dependencias inyectadas
 * (pool, store/storage, embeddings, firma, distiller/pii) para que
 * `src/partners/seed-partner-demo.test.ts` la ejecute con infra en memoria (mismo patrón que
 * `src/partners/publisher.test.ts`), y `main()` (abajo) la ejecute contra infra real: GCS real
 * (mismo backend que `scripts/create-partner-bundle.ts`), Postgres vía DATABASE_URL, KMS real y
 * embeddings Gemini reales.
 *
 * Uso: npx tsx scripts/seed-partner-demo.ts
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { Storage } from '@google-cloud/storage';
import matter from 'gray-matter';
import * as yaml from 'js-yaml';
import {
  BundleStore,
  BundleStorageBackend,
  FRONTMATTER_YAML_ENGINE,
  GenerationMismatchError,
  ReadResult,
  StoredObjectMeta,
} from '../src/infrastructure/bundle-store';
import { createPartnerBundleWithStorage } from '../src/partners/bundle';
import { ingestPartnerDocument } from '../src/partners/partner-ingest';
import { updatePartnerDraft } from '../src/partners/partner-draft-update';
import { publishPartnerPackage, PartnerPublishInput } from '../src/partners/publisher';
import { EmbeddingsClient, GeminiEmbeddingsClient } from '../src/infrastructure/embeddings';
import { KmsClient, signManifest } from '../src/partners/signer';
import { DistillerLlm } from '../src/ingestion/distiller-v2';
import { PiiLlm } from '../src/ingestion/pii-redactor';

// ==================== Identificadores fijos del aliado demo ====================

export const DEMO_PARTNER_ID = '00000000-0000-4000-8000-00000000d001';
export const DEMO_PARTNER_SLUG = 'bufete-demo';
export const DEMO_PACKAGE_ID = '00000000-0000-4000-8000-00000000d002';
export const DEMO_PACKAGE_SLUG = 'legal-esencial';
export const DEMO_TENANT_ID = 't-demo';
export const DEMO_VERSION = 1;
export const DEMO_CONTRACT_ID = '00000000-0000-4000-8000-00000000d003';

// ==================== Fixtures ====================

export interface FixtureConcept {
  slug: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  timestamp: string;
  sources: string[];
  altitude: number;
  body: string;
}

export interface FixtureFile {
  partner: { id: string; slug: string; legal_name: string };
  package: { id: string; slug: string };
  curator: { legal_name: string; responsible: string };
  concepts: FixtureConcept[];
}

const FIXTURES_PATH = path.join(__dirname, 'fixtures', 'partner-demo-concepts.json');

export function loadFixtures(): FixtureFile {
  const raw = readFileSync(FIXTURES_PATH, 'utf8');
  return JSON.parse(raw) as FixtureFile;
}

/**
 * Nombre de archivo de "documento fuente" con el que se ingesta cada fixture — usado tanto para
 * construir `document.filename` en `ingestPartnerDocument` como para que el stub de distiller
 * (abajo) identifique a qué fixture corresponde cada llamada de `generate()` (vía el
 * `source_ref` que `partner-ingest.ts` interpola en el prompt: `partner-ingest:{partner}/{pkg}/{filename}`).
 */
function sourceFilename(concept: FixtureConcept): string {
  return `${concept.slug}.txt`;
}

/**
 * Stub determinista de `DistillerLlm` (src/ingestion/distiller-v2.ts): en vez de llamar a
 * Gemini, identifica el fixture al que corresponde el prompt (vía el `source_ref` que
 * `partner-ingest.ts` siempre interpola en el prompt: `partner-ingest:{partner_id}/{package_slug}/{filename}`)
 * y devuelve EXACTAMENTE el JSON que `distiller-v2` espera (mismo shape que `DISTILL_PROMPT`:
 * type/title/description/tags/timestamp/sources/confidence/pii/altitude/body), tomado tal cual
 * del fixture. Así el contenido publicado es 100% determinista y los cross-links de los bodies
 * (que referencian slugs de otros fixtures) resuelven siempre igual.
 */
export function makeFixtureDistillerLlm(concepts: FixtureConcept[]): DistillerLlm {
  const byFilename = new Map(concepts.map((c) => [sourceFilename(c), c]));
  return {
    async generate(prompt: string): Promise<string> {
      const match = prompt.match(/source_ref:\s*partner-ingest:[^/\s]+\/[^/\s]+\/(\S+)/);
      const filename = match?.[1];
      const concept = filename ? byFilename.get(filename) : undefined;
      if (!concept) {
        throw new Error(
          `seed-partner-demo: makeFixtureDistillerLlm no pudo identificar el fixture del prompt (filename detectado: ${filename ?? 'ninguno'})`
        );
      }
      return JSON.stringify({
        type: concept.type,
        title: concept.title,
        description: concept.description,
        tags: concept.tags,
        timestamp: concept.timestamp,
        sources: concept.sources,
        confidence: 'draft',
        pii: 'clean',
        altitude: concept.altitude,
        body: concept.body,
      });
    },
  };
}

/**
 * Stub determinista de `PiiLlm` (src/ingestion/pii-redactor.ts): los fixtures ya son limpios
 * (sin PERSONA/DIRECCION reales), así que no marca ningún span. La pasada 1 (regex determinista
 * de pii-redactor.ts) sigue corriendo igual sobre el texto real.
 */
export function makeCleanPiiLlm(): PiiLlm {
  return {
    async detectSpans(): Promise<any[]> {
      return [];
    },
  };
}

// ==================== runSeed: lógica reutilizable (real e in-memory) ====================

export interface SeedPartnerDemoDeps {
  pool: Pool;
  /** BundleStore ya construido para el aliado demo (tenantId=DEMO_PARTNER_ID). */
  store: BundleStore;
  /**
   * Backend crudo subyacente de `store` (MISMO backend, no uno nuevo). DESVIACIÓN documentada:
   * `createPartnerBundleWithStorage` (src/partners/bundle.ts) recibe el `BundleStorageBackend`
   * crudo, no un `BundleStore` ya construido, así que no hay forma de derivarlo desde `store`
   * (no expone su backend privado). Ver reporte de la WU para el detalle.
   */
  storage: BundleStorageBackend;
  embeddings: EmbeddingsClient;
  signManifestFn?: typeof signManifest;
  kmsClient?: KmsClient;
  distillerLlm: DistillerLlm;
  piiLlm: PiiLlm;
}

export interface SeedPartnerDemoResult {
  conceptsPublished: number;
  manifestSha256: string;
  contractId: string;
}

/**
 * Ejecuta el pipeline real completo para sembrar los 12 conceptos del aliado demo:
 *   1. Bundle génesis (index.md, log.md, _staging/.keep) vía `createPartnerBundleWithStorage`.
 *   2. Ingesta de un "documento" por fixture vía `ingestPartnerDocument` -> draft en _staging/.
 *   3. Curaduría: completar `curator{legal_name,responsible}` en cada draft vía `updatePartnerDraft`
 *      (INV-2.3: sin curator completo el publish rechaza el batch).
 *   4. Publish real vía `publishPartnerPackage` -> ÚNICA escritura de
 *      okf_partner_concepts/okf_partner_edges [INV-9.1].
 *   5. Contrato de licencia de 90 días en `kdb_partner_licenses` (NO es el índice: upsert directo
 *      permitido, espeja lo que hará PA4-W3 license-sync).
 */
export async function runSeed(deps: SeedPartnerDemoDeps): Promise<SeedPartnerDemoResult> {
  const fixtures = loadFixtures();

  // 1. Bundle génesis.
  await createPartnerBundleWithStorage(DEMO_PARTNER_ID, deps.storage);

  // 2. Ingesta: un "documento" por fixture -> draft en _staging/.
  const draftPaths: string[] = [];
  for (const concept of fixtures.concepts) {
    const result = await ingestPartnerDocument(
      {
        partner_id: DEMO_PARTNER_ID,
        package_slug: DEMO_PACKAGE_SLUG,
        document: {
          filename: sourceFilename(concept),
          text: concept.body,
        },
      },
      deps.store,
      { distillerLlm: deps.distillerLlm, piiLlm: deps.piiLlm }
    );
    draftPaths.push(...result.drafts.map((d) => d.path));
  }

  // 3. Curaduría: inyectar curator{legal_name,responsible} en cada draft (INV-2.3).
  for (const draftPath of draftPaths) {
    const existing = await deps.store.read(draftPath);
    if (!existing) {
      throw new Error(`seed-partner-demo: draft no encontrado tras ingesta: ${draftPath}`);
    }
    const parsed = matter(existing.content, { engines: { yaml: FRONTMATTER_YAML_ENGINE } });
    const curatedFrontmatter = { ...parsed.data, curator: fixtures.curator };
    const curatedYaml = yaml.dump(curatedFrontmatter, { schema: yaml.JSON_SCHEMA });
    const curatedMarkdown = `---\n${curatedYaml}---\n\n${parsed.content}`;

    await updatePartnerDraft(
      { partner_id: DEMO_PARTNER_ID, draft_path: draftPath, markdown: curatedMarkdown },
      deps.store
    );
  }

  // 4. Publish real -> única vía de escritura del índice [INV-9.1].
  const publishInput: PartnerPublishInput = {
    partner_id: DEMO_PARTNER_ID,
    partner_slug: DEMO_PARTNER_SLUG,
    package_id: DEMO_PACKAGE_ID,
    package_slug: DEMO_PACKAGE_SLUG,
    version: DEMO_VERSION,
    draft_paths: draftPaths,
  };
  const { manifest } = await publishPartnerPackage(publishInput, {
    pool: deps.pool,
    embeddings: deps.embeddings,
    store: deps.store,
    kmsClient: deps.kmsClient,
    signManifestFn: deps.signManifestFn,
  });

  // 5. Contrato de licencia de 90 días (NO es el índice -> upsert directo permitido).
  const validFrom = new Date();
  const validUntil = new Date(validFrom.getTime() + 90 * 24 * 60 * 60 * 1000);
  await deps.pool.query(
    `INSERT INTO kdb_partner_licenses
       (contract_id, tenant_id, partner_id, package_id, version, systems, altitude_max, modules,
        valid_from, valid_until, status, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active', CURRENT_TIMESTAMP)
     ON CONFLICT (contract_id) DO UPDATE SET
       tenant_id     = EXCLUDED.tenant_id,
       partner_id    = EXCLUDED.partner_id,
       package_id    = EXCLUDED.package_id,
       version       = EXCLUDED.version,
       systems       = EXCLUDED.systems,
       altitude_max  = EXCLUDED.altitude_max,
       modules       = EXCLUDED.modules,
       valid_from    = EXCLUDED.valid_from,
       valid_until   = EXCLUDED.valid_until,
       status        = 'active',
       synced_at     = CURRENT_TIMESTAMP`,
    [
      DEMO_CONTRACT_ID,
      DEMO_TENANT_ID,
      DEMO_PARTNER_ID,
      DEMO_PACKAGE_ID,
      DEMO_VERSION,
      ['l-legal'],
      5,
      ['legal'],
      validFrom.toISOString(),
      validUntil.toISOString(),
    ]
  );

  const result: SeedPartnerDemoResult = {
    conceptsPublished: manifest.concepts.length,
    manifestSha256: manifest.manifest_sha256,
    contractId: DEMO_CONTRACT_ID,
  };

  console.log('[seed-partner-demo] conceptos publicados:', result.conceptsPublished);
  console.log('[seed-partner-demo] manifest_sha256:', result.manifestSha256);
  console.log('[seed-partner-demo] contract_id:', result.contractId);

  return result;
}

// ==================== main(): wiring REAL (GCS real, Postgres, KMS real, embeddings Gemini) ===

/**
 * Adaptador real sobre @google-cloud/storage — copiado del mismo patrón que
 * `scripts/create-partner-bundle.ts` (GcsRealBackendPartner), sin precondición de versioning
 * en bucket (la creación del bucket se maneja aparte, ver `ensureBucket` abajo).
 */
class GcsRealBackend implements BundleStorageBackend {
  private storage: Storage;
  private bucketName: string;

  constructor(bucketName: string) {
    this.storage = new Storage();
    this.bucketName = bucketName;
  }

  async read(path: string): Promise<ReadResult | null> {
    const file = this.storage.bucket(this.bucketName).file(path);
    try {
      const [buf] = await file.download();
      const [metadata] = await file.getMetadata();
      const generation = BigInt(metadata.generation ?? 0);
      return { content: buf.toString('utf8'), generation };
    } catch (error: any) {
      if (error?.code === 404) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<StoredObjectMeta[]> {
    const [files] = await this.storage.bucket(this.bucketName).getFiles({ prefix });
    return files.map((f) => ({
      path: f.name,
      generation: BigInt(f.metadata.generation ?? 0),
    }));
  }

  async save(path: string, content: string, opts?: { ifGenerationMatch?: bigint }): Promise<bigint> {
    const file = this.storage.bucket(this.bucketName).file(path);
    try {
      await file.save(content, {
        resumable: false,
        preconditionOpts:
          opts?.ifGenerationMatch !== undefined
            ? { ifGenerationMatch: opts.ifGenerationMatch.toString() }
            : undefined,
      });
      const [metadata] = await file.getMetadata();
      return BigInt(metadata.generation ?? 0);
    } catch (error: any) {
      if (error?.code === 412) throw new GenerationMismatchError(path);
      throw error;
    }
  }
}

async function ensureBucket(bucketName: string): Promise<void> {
  const storage = new Storage();
  const [exists] = await storage.bucket(bucketName).exists();
  if (exists) {
    console.log(`[seed-partner-demo] Bucket ${bucketName} ya existe, continuando...`);
    return;
  }
  console.log(`[seed-partner-demo] Creando bucket ${bucketName} en region us-central1...`);
  await storage.createBucket(bucketName, {
    location: 'us-central1',
    labels: { partner: DEMO_PARTNER_ID },
    versioning: { enabled: true },
    uniformBucketLevelAccess: { enabled: true },
  });
  console.log(`[seed-partner-demo] Bucket ${bucketName} creado exitosamente`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Uso: DATABASE_URL=postgres://... npx tsx scripts/seed-partner-demo.ts');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const bucketName = `${process.env.GCS_PARTNER_BUNDLE_PREFIX ?? 'kdb-partner-'}${DEMO_PARTNER_ID}`;

  try {
    await ensureBucket(bucketName);
    const storage = new GcsRealBackend(bucketName);
    const store = new BundleStore({ tenantId: DEMO_PARTNER_ID, storage });
    const embeddings = new GeminiEmbeddingsClient();
    const fixtures = loadFixtures();
    const distillerLlm = makeFixtureDistillerLlm(fixtures.concepts);
    const piiLlm = makeCleanPiiLlm();

    const result = await runSeed({ pool, store, storage, embeddings, distillerLlm, piiLlm });
    console.log('[seed-partner-demo] OK', result);
  } catch (error) {
    console.error('[seed-partner-demo] Error durante la siembra:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Solo ejecutar main() si se llama directamente (no en import, p.ej. desde el test).
if (require.main === module || process.argv[1]?.endsWith('seed-partner-demo.ts')) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
