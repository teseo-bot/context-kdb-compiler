// K3-W2 (BACKEND §A8, TRD §5): índice delta — sincroniza el bundle GCS (fuente de verdad)
// con `okf_concepts` / `okf_edges` / `okf_provenance` en el Cold-Tier, para que las tools de
// consumo (kdb_browse/kdb_search) puedan leer sin ir a GCS en cada request.
//
// Algoritmo de indexDelta (BACKEND §A8):
//   1. BundleStore.list('') de los 7 directorios de sistema HOCFLIT + index.md raíz
//      (excluir `_staging/`, `log.md`, `_fuentes/`).
//   2. Comparar `generation` de GCS vs `okf_concepts.gcs_generation` -> solo los objetos
//      cambiados (nuevos o con generation distinta) se reindexan; el resto se cuenta 'skipped'.
//   3. Por cada cambiado: parsear con gray-matter -> extraer cross-links del cuerpo con el
//      regex de §A8 -> upsert okf_concepts (embedding de `${title}\n${description}\n${body}`
//      truncado a 8000 chars) -> replace okf_edges del from_path -> upsert okf_provenance
//      desde `sources` del frontmatter.
//   3.1 Los `index.md` (raíz y de sistema) NO llevan frontmatter de concepto (son plantillas
//       de K2-W2, ver nota de decisión más abajo sobre system_slug/altitude para ellos).
//
// Toda operación de BD ejecuta `set_config('app.tenant_id', ...)` antes de tocar filas
// (RLS FORCE lo exige).

import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import matter from 'gray-matter';
import { BundleStore, FRONTMATTER_YAML_ENGINE } from '../infrastructure/bundle-store';
import { EmbeddingsClient } from '../infrastructure/embeddings';
import { HOCFLIT_SYSTEMS } from '../infrastructure/concept-frontmatter.schema';
import { normalizeBrandSlugs } from '../infrastructure/brand-slugs';

const MAX_EMBED_INPUT_CHARS = 8000;
const CROSS_LINK_REGEX = /\]\((\/[a-z0-9-]+\/[a-z0-9-]+\.md)\)/g;

const EXCLUDED_PREFIXES = ['_staging/', '_fuentes/'];
const EXCLUDED_PATHS = new Set(['log.md']);

export interface IndexerDeps {
  pool: Pool;
  store: BundleStore;
  embeddings: EmbeddingsClient;
}

/**
 * DECISIÓN DOCUMENTADA (K3-W2): los `index.md` (raíz y de sistema, plantillas de K2-W2) no
 * llevan frontmatter de concepto — BACKEND §A8 pide indexarlos con `frontmatter: '{}'::jsonb`.
 * El DDL real (migrations/003_okf_index.sql, verificado antes de escribir este módulo) define
 * `altitude SMALLINT NOT NULL CHECK (altitude BETWEEN 1 AND 5)`: NOT NULL, sin default. Como
 * estos index.md no tienen un altitude propio del frontmatter, se usa el valor fijo 3 (altitude
 * intermedia, ver TRD §3 "1=operativo … 5=estratégico" y BACKEND §C2 "índice global... altitude
 * ≥3 es el Nivel 3 intra-tenant") para TODOS los index.md de sistema y para el index.md raíz.
 *
 * Para `system_slug`: la columna es TEXT NOT NULL SIN CHECK/enum en el DDL real (confirmado
 * contra Postgres local), por lo que '_root' es un valor válido para el index.md de la raíz del
 * bundle (no pertenece a ningún sistema HOCFLIT). Los index.md de sistema (`{sistema}/index.md`)
 * usan el propio slug del sistema (primer segmento del path) como system_slug, igual que
 * cualquier otro concepto de ese directorio.
 */
const INDEX_MD_ALTITUDE = 3;
const ROOT_SYSTEM_SLUG = '_root';

/**
 * ADR-210 D-210.13 — confianza explícita en la arista: EXTRACTED vs INFERRED.
 *
 * Duplicado consciente de contracts/src/okf.ts (`okfEdgeOrigin`), por el mismo motivo ya
 * documentado en infrastructure/concept-frontmatter.schema.ts: @teseo/contracts no es
 * dependencia npm del compiler y el import relativo rompe `tsc --noEmit` con TS6059.
 *
 * Las aristas no las emite el destilador: se materializan de los cross-links markdown del
 * cuerpo (extractCrossLinks, más abajo). Este módulo lee un objeto de GCS y no sabe quién
 * escribió ese cuerpo, así que la marca tiene que derivarse de algo que viaje en el propio
 * artefacto. `frontmatter.confidence` ya es exactamente esa señal:
 *
 *   · 'draft'                     → salió del destilador L1 y nadie lo revisó ⇒ INFERRED.
 *   · 'reviewed' | 'consolidated' → un humano lo endosó ⇒ EXTRACTED.
 *   · null (los index.md, plantillas de navegación de K2-W2, que no llevan frontmatter de
 *     concepto) ⇒ EXTRACTED: son estructura definida a mano, no inferencia.
 *
 * El endoso humano es la misma semántica que ADR-203 vende como "certificado", así que
 * promover editorialmente un concepto promueve sus aristas en el siguiente reindexado, sin
 * paso operativo extra.
 */
type EdgeOrigin = 'EXTRACTED' | 'INFERRED';

function edgeOriginFor(confidence: unknown): EdgeOrigin {
  return confidence === 'draft' ? 'INFERRED' : 'EXTRACTED';
}

/**
 * ADR-215 WU-4.4 — la MARCA de un concepto OKF, derivada de `frontmatter.brands`.
 *
 * Mismo razonamiento que `edgeOriginFor` justo arriba: este módulo lee un objeto de GCS y no
 * sabe quién escribió el cuerpo, así que la marca debe viajar en el propio artefacto. `brands`
 * es esa señal, y se normaliza con el MISMO helper que usa la ingesta de documentos
 * (`normalizeBrandSlugs`) para que un concepto no filtre distinto según por dónde entró.
 *
 * Ausente, vacío o mal tecleado ⇒ `[]` = COMPARTIDO, visible para todas las marcas [INV-215.5].
 *
 * Los `index.md` van SIEMPRE compartidos, y a propósito: su `frontmatter` se fuerza a `{}` unas
 * líneas más abajo porque son plantillas de navegación (K2-W2), no conceptos. Y es lo correcto
 * además de lo que sale solo — un índice con marca escondería TODOS sus hijos a la otra marca,
 * incluidos los compartidos. El índice es el andamio; la marca vive en las hojas, que el lector
 * filtra una por una (orquestador, WU-4.3).
 */
function brandSlugsFor(brands: unknown): string[] {
  return normalizeBrandSlugs(brands);
}

interface ListedObject {
  path: string;
  generation: bigint;
}

interface ConceptRow {
  path: string;
  gcs_generation: string | null;
}

function isIndexablePath(path: string): boolean {
  if (EXCLUDED_PATHS.has(path)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (path === 'index.md') return true;
  const [firstSegment] = path.split('/');
  return (HOCFLIT_SYSTEMS as readonly string[]).includes(firstSegment);
}

function systemSlugForPath(path: string): string {
  if (path === 'index.md') return ROOT_SYSTEM_SLUG;
  return path.split('/')[0];
}

function isIndexMdPath(path: string): boolean {
  return path === 'index.md' || path.endsWith('/index.md');
}

function extractCrossLinks(body: string): string[] {
  const links = new Set<string>();
  let m: RegExpExecArray | null;
  CROSS_LINK_REGEX.lastIndex = 0;
  while ((m = CROSS_LINK_REGEX.exec(body)) !== null) {
    // El regex captura con slash inicial ("/c-comercial/otro.md"); okf_edges.to_path se
    // guarda sin slash inicial, consistente con los `path` de okf_concepts (ej.
    // 'c-comercial/objeciones-precio.md').
    links.add(m[1].replace(/^\//, ''));
  }
  return Array.from(links);
}

async function withTenant<T>(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenantId]);
    return await fn(client);
  } finally {
    await client.query('RESET app.tenant_id');
    client.release();
  }
}

/**
 * indexConcept: (re)indexa un único path del bundle. Lee el objeto vigente de GCS vía
 * BundleStore, lo parsea y hace upsert en okf_concepts/okf_edges/okf_provenance.
 * Si el path ya no existe en el bundle (fue borrado/movido, lo cual normalmente no ocurre
 * porque el bundle es append-only, pero puede pasar en tests), no hace nada.
 */
export async function indexConcept(
  tenantId: string,
  path: string,
  deps: { pool: Pool; store: BundleStore; embeddings: EmbeddingsClient }
): Promise<void> {
  const object = await deps.store.read(path);
  if (!object) return;

  await withTenant(deps.pool, tenantId, async (client) => {
    await indexSingleConcept(client, tenantId, path, object.content, object.generation, deps.embeddings);
  });
}

async function indexSingleConcept(
  client: PoolClient,
  tenantId: string,
  path: string,
  content: string,
  generation: bigint,
  embeddings: EmbeddingsClient
): Promise<void> {
  const isIndexMd = isIndexMdPath(path);
  const parsed = matter(content, { engines: { yaml: FRONTMATTER_YAML_ENGINE } });
  const frontmatter = isIndexMd ? {} : (parsed.data as Record<string, unknown>);
  const bodyText = parsed.content.trim();

  const title = typeof frontmatter.title === 'string' ? frontmatter.title : '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  const altitude = isIndexMd
    ? INDEX_MD_ALTITUDE
    : typeof frontmatter.altitude === 'number'
      ? frontmatter.altitude
      : INDEX_MD_ALTITUDE;
  const systemSlug = systemSlugForPath(path);
  // WU-4.4: `frontmatter` ya es `{}` para los index.md, así que esto les da [] = compartido por
  // construcción, no por dato ausente — el mismo criterio que `origin` unas líneas abajo.
  const brandSlugs = brandSlugsFor(frontmatter.brands);

  const embedInput = `${title}\n${description}\n${bodyText}`.slice(0, MAX_EMBED_INPUT_CHARS);
  const [embedding] = await embeddings.embed([embedInput]);
  const embeddingLiteral = `[${embedding.join(',')}]`;

  const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');

  await client.query(
    // WU-4.4: $1..$10 — DIEZ marcadores, DIEZ elementos. `brand_slugs` va también en el DO UPDATE:
    // sin eso, reetiquetar un concepto y reindexarlo dejaría la marca vieja en la fila, y el
    // reindexado es precisamente el camino por el que se corrige una marca mal puesta.
    `INSERT INTO okf_concepts
       (tenant_id, path, frontmatter, body_text, embedding, content_sha256, gcs_generation, altitude, system_slug, brand_slugs, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
     ON CONFLICT (tenant_id, path) DO UPDATE SET
       frontmatter = EXCLUDED.frontmatter,
       body_text = EXCLUDED.body_text,
       embedding = EXCLUDED.embedding,
       content_sha256 = EXCLUDED.content_sha256,
       gcs_generation = EXCLUDED.gcs_generation,
       altitude = EXCLUDED.altitude,
       system_slug = EXCLUDED.system_slug,
       brand_slugs = EXCLUDED.brand_slugs,
       updated_at = CURRENT_TIMESTAMP`,
    [
      tenantId,
      path,
      JSON.stringify(frontmatter),
      bodyText,
      embeddingLiteral,
      contentSha256,
      generation.toString(),
      altitude,
      systemSlug,
      brandSlugs,
    ]
  );

  // Replace okf_edges del from_path: borrar todas las salientes de este path y reinsertar
  // las extraídas del cuerpo actual.
  await client.query('DELETE FROM okf_edges WHERE tenant_id = $1 AND from_path = $2', [tenantId, path]);
  const crossLinks = extractCrossLinks(bodyText);
  // Los index.md no llevan frontmatter de concepto (ver `frontmatter` arriba, que para ellos
  // es {}), así que su confidence es null por construcción, no por dato ausente.
  const origin = edgeOriginFor(isIndexMd ? null : frontmatter.confidence);
  for (const toPath of crossLinks) {
    await client.query(
      `INSERT INTO okf_edges (tenant_id, from_path, to_path, origin)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, from_path, to_path) DO UPDATE SET origin = EXCLUDED.origin`,
      [tenantId, path, toPath, origin]
    );
  }

  // Upsert okf_provenance desde sources del frontmatter (los index.md no tienen sources).
  const sources = Array.isArray(frontmatter.sources) ? (frontmatter.sources as unknown[]) : [];
  for (const source of sources) {
    if (typeof source !== 'string') continue;
    await client.query(
      `INSERT INTO okf_provenance (tenant_id, concept_path, source_ref)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, concept_path, source_ref) DO NOTHING`,
      [tenantId, path, source]
    );
  }
}

/**
 * indexDelta: recorre el bundle completo (los 7 directorios de sistema + index.md raíz,
 * excluyendo `_staging/`, `log.md` y `_fuentes/`), compara `generation` de GCS contra
 * `okf_concepts.gcs_generation` y reindexa solo lo cambiado (nuevo o con generation distinta).
 */
export async function indexDelta(
  tenantId: string,
  deps: { pool: Pool; store: BundleStore; embeddings: EmbeddingsClient }
): Promise<{ indexed: number; skipped: number }> {
  const allObjects = await deps.store.list('');
  const candidates: ListedObject[] = allObjects.filter((o) => isIndexablePath(o.path));

  const known = await withTenant(deps.pool, tenantId, async (client) => {
    const res = await client.query<ConceptRow>(
      'SELECT path, gcs_generation FROM okf_concepts WHERE tenant_id = $1',
      [tenantId]
    );
    const map = new Map<string, bigint | null>();
    for (const row of res.rows) {
      map.set(row.path, row.gcs_generation === null ? null : BigInt(row.gcs_generation));
    }
    return map;
  });

  let indexed = 0;
  let skipped = 0;

  for (const object of candidates) {
    const knownGeneration = known.get(object.path);
    const changed = knownGeneration === undefined || knownGeneration !== object.generation;

    if (!changed) {
      skipped++;
      continue;
    }

    await indexConcept(tenantId, object.path, deps);
    indexed++;
  }

  return { indexed, skipped };
}
