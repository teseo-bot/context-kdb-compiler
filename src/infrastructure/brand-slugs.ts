/**
 * ADR-215 — normalización de las marcas (`brand_slugs`), en UN solo sitio.
 *
 * La marca entra al corpus por DOS puertas distintas: la ingesta de documentos
 * (`core/compiler-engine.ts`, desde `metadata.brandSlugs` que manda el panel) y el indexador OKF
 * (`indexing/indexer.ts`, desde `frontmatter.brands` que viene del YAML del artefacto). Vive aquí
 * —y no en una de las dos— porque con un normalizador por puerta el MISMO concepto acabaría
 * filtrando distinto según por dónde entró, y eso es indetectable mirando una sola de las dos.
 *
 * Es el mismo criterio que `joinLicenciaAliado` en el orquestador: un gate copiado en varios
 * sitios divergió, y el efecto fue un permiso que se relajaba según la puerta de entrada.
 */

/**
 * Minúsculas, sin espacios, sin vacíos, sin duplicados y en orden estable. Un
 * `['Fleetco', 'fleetco', '']` tecleado a mano y un `['fleetco']` deben producir exactamente la
 * misma fila.
 *
 * Acepta `unknown` porque `frontmatter.brands` sale de YAML del usuario y puede ser una cadena,
 * un número o un objeto. Cualquier cosa que no sea un array de cadenas cae a `[]`, que significa
 * COMPARTIDO — visible para todas las marcas [INV-215.5].
 *
 * ⚠️ Que la degradación sea «compartido» y no «nada» es deliberado en el ESCRITOR, y es lo
 * contrario de lo que hace el LECTOR: al leer, la ausencia de marca acota a sólo-compartido. Las
 * dos direcciones son la segura en su lado — al escribir, marcar de menos deja el documento
 * visible (recuperable, y corregible reetiquetando); al leer, asumir de menos evita servir el
 * corpus de otra marca.
 */
export function normalizeSlugs(input?: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  return Array.from(
    new Set(
      input
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    )
  ).sort();
}

/**
 * ADR-220 — el proyecto usa EXACTAMENTE el mismo normalizador, y por la misma razón por la que
 * éste vive en un archivo propio: con uno por eje, el mismo valor tecleado acabaría filtrando
 * distinto según la puerta por la que entró. Se exporta con el nombre viejo para no tocar los
 * dos call sites de marca.
 */
export const normalizeBrandSlugs = normalizeSlugs;
export const normalizeProjectSlugs = normalizeSlugs;
