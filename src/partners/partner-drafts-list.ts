/**
 * KL3-W1: listado y lectura de drafts de aliado en `_staging/` (Knowledge Lab, editor guiado).
 *
 * FILTRO as-built (PLAN-KnowledgeLab-Epicas-KL.md §0, resolución PA2-W4, 2026-07-08):
 * `BundleStore` es append-only (src/infrastructure/bundle-store.ts: "NO se expone `delete`") —
 * los drafts publicados NO se borran de `_staging/`. Para que un draft ya publicado no
 * reaparezca como "pendiente" en el editor, `listPartnerDrafts` excluye cualquier draft cuyo
 * SLUG (nombre de archivo, sin extensión) ya exista publicado bajo `paquetes/{package_slug}/`.
 * Se resuelve contra el índice `okf_partner_concepts` (columna `gcs_path`, poblada por
 * `publisher.ts` como `paquetes/{package_slug}/{filename}`) en vez de listar GCS de nuevo —
 * más barato, y evita depender de RLS/credenciales de storage extra.
 *
 * Criterio exacto: `gcs_path LIKE 'paquetes/%/{slug}.md'` (o `'paquetes/{package_slug}/%.md'`
 * si el caller pasa `package_slug`), scoped por `partner_id`. La comparación es por BASENAME
 * (slug), no por ruta completa de `_staging/`, porque `_staging/` NO está particionada por
 * paquete: `partner-ingest.ts` escribe a `_staging/{fecha}/{slug}.md` sin ninguna referencia a
 * `package_slug` en el path ni en el frontmatter (un draft no tiene paquete asignado hasta que
 * se publica — la asociación draft→paquete la decide el panel al construir `draft_paths[]` para
 * `/internal/partner-publish`). Por esa misma razón, `package_slug` en el input de esta función
 * NO filtra qué objetos de `_staging/` se listan (siempre se listan TODOS los del partner);
 * solo acota contra qué paquete publicado se compara para la exclusión. Si se omite, se excluye
 * cualquier slug publicado en CUALQUIER paquete del partner (comportamiento más conservador).
 */

import matter from 'gray-matter';
import { BundleStore, FRONTMATTER_YAML_ENGINE } from '../infrastructure/bundle-store';
import { validateDraftPath } from './partner-draft-update';

export interface PartnerDraftsListInput {
  partner_id: string;
  package_slug?: string;
}

export interface PartnerDraftListItem {
  path: string;
  title: string;
  type: string;
  system: string;
  altitude: number;
  pii: string;
  confidence: string;
  updated?: string;
}

export interface PartnerDraftsListResult {
  drafts: PartnerDraftListItem[];
}

export interface PartnerDraftGetInput {
  partner_id: string;
  draft_path: string;
}

export interface PartnerDraftGetResult {
  markdown: string;
}

/**
 * Superficie mínima de `pg.Pool` que esta función necesita — permite inyectar un fake en tests
 * dirigidos sin levantar Postgres real (mismo espíritu que `BundleStorageBackend`).
 */
export interface MinimalQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function slugOf(path: string): string {
  return basename(path).replace(/\.md$/i, '');
}

/**
 * Parsea frontmatter con el mismo engine YAML seguro que usa el resto del repo
 * (`FRONTMATTER_YAML_ENGINE`, K3-W2) — evita que js-yaml convierta timestamps ISO a `Date`.
 * Devuelve `null` si el bloque `---...---` no existe o no es parseable (draft roto: se omite
 * del listado en vez de reventar toda la respuesta — un solo draft corrupto no debe tumbar el
 * editor de todo el paquete).
 */
function parseFrontmatterSafe(markdown: string): Record<string, unknown> | null {
  const withoutBom = markdown.replace(/^﻿/, '');
  if (!/^---\r?\n/.test(withoutBom)) return null;
  try {
    const parsed = matter(withoutBom, { engines: { yaml: FRONTMATTER_YAML_ENGINE } });
    return parsed.data ?? {};
  } catch {
    return null;
  }
}

/**
 * Slugs ya publicados para este partner (y, opcionalmente, este `package_slug`) según el índice
 * `okf_partner_concepts`. Ver cabecera del archivo para el criterio exacto.
 */
async function getPublishedSlugs(
  input: PartnerDraftsListInput,
  pool: MinimalQueryable
): Promise<Set<string>> {
  const pattern = input.package_slug
    ? `paquetes/${input.package_slug}/%.md`
    : `paquetes/%/%.md`;

  const { rows } = await pool.query(
    'SELECT DISTINCT gcs_path FROM okf_partner_concepts WHERE partner_id = $1 AND gcs_path LIKE $2',
    [input.partner_id, pattern]
  );

  return new Set(rows.map((r: { gcs_path: string }) => slugOf(r.gcs_path)));
}

/**
 * Lista los drafts pendientes (no publicados) bajo `_staging/` del bundle de un aliado.
 * Cero escrituras.
 */
export async function listPartnerDrafts(
  input: PartnerDraftsListInput,
  store: BundleStore,
  pool: MinimalQueryable
): Promise<PartnerDraftsListResult> {
  const objects = await store.list('_staging/');
  const mdObjects = objects.filter((o) => o.path.toLowerCase().endsWith('.md'));

  const publishedSlugs = await getPublishedSlugs(input, pool);

  const drafts: PartnerDraftListItem[] = [];
  for (const obj of mdObjects) {
    if (publishedSlugs.has(slugOf(obj.path))) continue; // ya publicado — filtro as-built PA2-W4

    const stored = await store.read(obj.path);
    if (!stored) continue; // carrera improbable (listado vs. lectura); se omite, no revienta
    const frontmatter = parseFrontmatterSafe(stored.content);
    if (!frontmatter) continue; // draft con frontmatter roto: se omite del listado

    const tags = Array.isArray(frontmatter.tags) ? (frontmatter.tags as unknown[]) : [];

    drafts.push({
      path: obj.path,
      title: typeof frontmatter.title === 'string' ? frontmatter.title : '',
      type: typeof frontmatter.type === 'string' ? frontmatter.type : '',
      system: typeof tags[0] === 'string' ? (tags[0] as string) : '',
      altitude: typeof frontmatter.altitude === 'number' ? frontmatter.altitude : 0,
      pii: typeof frontmatter.pii === 'string' ? frontmatter.pii : '',
      confidence: typeof frontmatter.confidence === 'string' ? frontmatter.confidence : '',
      updated: typeof frontmatter.timestamp === 'string' ? frontmatter.timestamp : undefined,
    });
  }

  return { drafts };
}

/**
 * Lee el markdown crudo de un draft bajo `_staging/`. Reúsa el guard anti-traversal de
 * `partner-draft-update.ts` (mismo criterio: debe empezar con `_staging/`, sin `..`, terminar
 * en `.md`) — 422 si no cumple.
 */
export async function getPartnerDraft(
  input: PartnerDraftGetInput,
  store: BundleStore
): Promise<PartnerDraftGetResult> {
  const pathValidation = validateDraftPath(input.draft_path);
  if (!pathValidation.valid) {
    throw { code: 422, message: pathValidation.reason || 'Invalid draft path' };
  }

  const stored = await store.read(input.draft_path);
  if (!stored) {
    throw { code: 404, message: `Draft no encontrado: ${input.draft_path}` };
  }

  return { markdown: stored.content };
}
