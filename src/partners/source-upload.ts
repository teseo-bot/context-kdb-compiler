/**
 * KL2-W1: Subida de fuentes crudas del aliado a `_fuentes/` del bundle
 *
 * Espeja la mecánica raw que usa el génesis del bundle (bundle.ts::writePartnerBundle,
 * PA2-W1) para escribir `_staging/.keep`: usa `BundleStore.write()` directamente sobre un
 * path que NO termina en `.md`, por lo que `requiresFrontmatterValidation()` (bundle-store.ts)
 * no se dispara y el objeto se escribe sin exigir frontmatter OKF. `write()` sigue siendo la
 * ÚNICA vía de escritura del bundle, así que la entrada SÍ queda registrada en el hash-chain de
 * `log.md` (misma garantía de custodia que cualquier otro escrito).
 *
 * Codificación: el contenido se guarda en el objeto GCS TAL CUAL llega en `content_base64`
 * (texto ASCII-safe), no los bytes binarios decodificados. Motivo: `BundleStorageBackend.save`
 * (bundle-store.ts) firma `content: string` y el adaptador real (`GcsStorageBackend.save`)
 * termina codificando ese string como UTF-8 al pasarlo al cliente de GCS — decodificar a bytes
 * binarios y volver a convertir a "string binario" (`latin1`) NO sobrevive ese paso para bytes
 * >0x7F (se corrompen). Guardar el base64 tal cual es ASCII puro y por tanto un round-trip
 * perfecto; el sha256 devuelto y usado en el nombre del objeto SÍ se calcula sobre los bytes
 * binarios reales (Buffer decodificado), no sobre el string base64. Cualquier lector de este
 * objeto (p.ej. `/internal/partner-ingest` con `source_gcs_object`, KL2-W1/W2) debe tratar el
 * contenido leído como base64 y decodificarlo antes de usarlo.
 */

import { createHash } from 'node:crypto';
import { BundleStore } from '../infrastructure/bundle-store';

const FUENTES_PREFIX = '_fuentes/';
const MAX_SOURCE_BYTES = 20 * 1024 * 1024; // 20MB — ninguna ruta /internal/* existente impone
// un límite (partner-ingest/partner-draft-update reciben markdown, no binarios arbitrarios);
// se introduce aquí porque este endpoint acepta cualquier documento subido por el aliado.

export class PartnerSourceTooLargeError extends Error {
  code = 413 as const;
  constructor(sizeBytes: number) {
    super(`Fuente demasiado grande: ${sizeBytes} bytes (máximo ${MAX_SOURCE_BYTES} bytes = 20MB).`);
    this.name = 'PartnerSourceTooLargeError';
  }
}

export interface UploadPartnerSourceInput {
  partner_id: string;
  filename: string;
  content_base64: string;
}

export interface UploadPartnerSourceResult {
  sha256: string;
  gcs_object: string;
  /** false cuando el objeto ya existía (mismo contenido subido antes) — idempotente, no se
   * reescribe ni se añade entrada nueva al hash-chain. */
  created: boolean;
}

/** Extensión del filename (incluye el punto), o '' si no tiene. Ignora cualquier segmento de
 * ruta en filename (solo se usa el basename) — el filename es metadato, nunca se usa como path
 * de escritura (el path real es `_fuentes/{sha256}{ext}`, inmune a path traversal). */
function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // sin extensión, o dotfile tipo '.env' (dot===0)
  return base.slice(dot);
}

/**
 * Sube una fuente cruda del aliado a `_fuentes/{sha256}{ext}` del bundle. Puro respecto al
 * cómputo (sha256 del binario real); el único efecto secundario es la escritura vía
 * `store.write()` (que incluye su propio append a `log.md`).
 */
export async function uploadPartnerSource(
  input: UploadPartnerSourceInput,
  store: BundleStore
): Promise<UploadPartnerSourceResult> {
  const binary = Buffer.from(input.content_base64, 'base64');

  if (binary.length > MAX_SOURCE_BYTES) {
    throw new PartnerSourceTooLargeError(binary.length);
  }

  const sha256 = createHash('sha256').update(binary).digest('hex');
  const gcsObject = `${FUENTES_PREFIX}${sha256}${extensionOf(input.filename)}`;

  const existing = await store.read(gcsObject);
  if (existing) {
    // Idempotente: mismo contenido (mismo sha256 ⇒ mismo path) ya subido. 200 con el mismo
    // objeto, cero escrituras nuevas (ni al objeto ni a log.md).
    return { sha256, gcs_object: gcsObject, created: false };
  }

  await store.write(gcsObject, input.content_base64, {
    actor: 'partner-source-upload-api',
    accion: 'draft',
  });

  return { sha256, gcs_object: gcsObject, created: true };
}
