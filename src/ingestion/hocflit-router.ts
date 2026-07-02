// K4-W1 (BACKEND §A5): ruteo HOCFLIT — genera target_path para un DraftConcept
// y resuelve colisiones de slug dentro de un mismo directorio de sistema.

import { HOCFLIT_SYSTEMS } from '../infrastructure/concept-frontmatter.schema';

/**
 * slugify: lowercase, sin acentos (NFD + strip diacríticos), espacios/separadores -> '-',
 * solo [a-z0-9-], colapsar '--', trim de '-', máx 60 chars.
 */
export function slugify(title: string): string {
  const noAccents = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // strip diacríticos

  let slug = noAccents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // espacios y cualquier separador no [a-z0-9] -> '-'
    .replace(/-{2,}/g, '-') // colapsar '--'
    .replace(/^-+|-+$/g, ''); // trim de '-'

  if (slug.length > 60) {
    slug = slug.slice(0, 60).replace(/-+$/g, '');
  }

  return slug;
}

/**
 * buildTargetPath: valida que tags[0] sea un sistema HOCFLIT válido (throw si no)
 * y devuelve `${tags[0]}/${slugify(title)}.md`.
 */
export function buildTargetPath(frontmatter: { tags: string[] }, title: string): string {
  const system = frontmatter.tags[0];
  if (!(HOCFLIT_SYSTEMS as readonly string[]).includes(system)) {
    throw new Error(
      `tags[0] inválido: '${system}' no es un sistema HOCFLIT válido (${HOCFLIT_SYSTEMS.join(', ')})`
    );
  }
  return `${system}/${slugify(title)}.md`;
}

/**
 * Trigramas (3-gramas de caracteres) de un string normalizado (lowercase, sin acentos).
 */
function trigrams(value: string): Set<string> {
  const normalized = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

  if (normalized.length < 3) {
    return new Set([normalized]);
  }

  const grams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

/**
 * Similitud por trigramas (Jaccard-like: intersección / mínimo tamaño de conjunto)
 * entre dos títulos. Devuelve un valor en [0, 1].
 */
function trigramSimilarity(a: string, b: string): number {
  const gramsA = trigrams(a);
  const gramsB = trigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;

  let shared = 0;
  for (const g of gramsA) {
    if (gramsB.has(g)) shared++;
  }
  return shared / Math.min(gramsA.size, gramsB.size);
}

/**
 * resolveCollision (BACKEND §A5 punto 3, alcance de esta WU):
 * - Implementa SOLO la lógica de similitud por trigramas en TypeScript puro (sin BD).
 * - El caller (K4-W2, candidate-poller/staging-writer) es responsable de obtener
 *   `existingTitles` reales desde el índice (okf_concepts) antes de invocar esta función;
 *   aquí se recibe ya resuelto como parámetro.
 *
 * Regla:
 *  - Si algún título existente comparte >50% de trigramas con el nuevo título -> se
 *    considera el MISMO concepto: se conserva el targetPath tal cual (no hay colisión real).
 *  - Si el path colisiona (existe algún título ya presente en ese directorio, es decir
 *    `existingTitles` no está vacío) pero el título difiere (similitud <=50% con todos los
 *    existentes) -> se agrega sufijo '-2' antes de '.md'.
 *  - Si no hay títulos existentes (sin colisión de path) -> se conserva el targetPath.
 */
export async function resolveCollision(
  targetPath: string,
  existingTitles: string[],
  newTitle: string
): Promise<string> {
  if (existingTitles.length === 0) {
    return targetPath;
  }

  const isSameConcept = existingTitles.some((existing) => trigramSimilarity(existing, newTitle) > 0.5);
  if (isSameConcept) {
    return targetPath;
  }

  return targetPath.replace(/\.md$/, '-2.md');
}
