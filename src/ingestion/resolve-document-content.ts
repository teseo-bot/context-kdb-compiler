import { DocumentDistiller } from './distiller';
import { IngestDocument } from '../schemas/contracts';

// K9-W1b (gap PDFs binarios en /v1/ingest): resuelve el `content` final (texto/markdown)
// de un IngestDocument a partir de su content_encoding.
//   - utf8 (default): `content` ya es texto plano/markdown. Comportamiento previo intacto.
//   - base64: `content` es el buffer del archivo original codificado en base64. Se decodifica
//     y, si mime_type es soportado por DocumentDistiller.processBuffer (pdf/txt/markdown/csv/
//     media), se extrae el texto. mime_type ausente o no soportado → error claro.
//
// Se extrae como función pura (sin tocar CompilerEngine/Pool) para poder testear el flujo
// de extracción sin necesidad de una base de datos real, siguiendo el mismo patrón que
// src/ingestion/distiller.test.ts (DocumentDistiller ya no depende de Postgres).

const MEDIA_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/mpeg',
  'video/mp4',
]);

function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_DIRECT_KEY || process.env.GEMINI_API_KEYS?.split(',')[0]);
}

/**
 * Resuelve el texto/markdown final a compilar para un documento del batch de /v1/ingest.
 * Lanza Error con mensaje claro si la extracción no es posible; el caller (handler del
 * server) decide cómo reportar el fallo por-documento sin tumbar el batch completo.
 */
export async function resolveDocumentContent(
  doc: Pick<IngestDocument, 'content' | 'content_encoding' | 'mime_type' | 'document_id'>,
  distiller: DocumentDistiller = new DocumentDistiller()
): Promise<string> {
  if (doc.content_encoding !== 'base64') {
    // utf8 (default): comportamiento actual intacto.
    return doc.content;
  }

  const mimeType = doc.mime_type;
  if (!mimeType) {
    throw new Error(
      `Documento ${doc.document_id}: content_encoding='base64' requiere mime_type para poder extraer el contenido.`
    );
  }

  if (MEDIA_MIME_TYPES.has(mimeType) && !hasGeminiKey()) {
    throw new Error(
      `Documento ${doc.document_id}: extracción de ${mimeType} requiere GEMINI_DIRECT_KEY.`
    );
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(doc.content, 'base64');
  } catch (err) {
    throw new Error(
      `Documento ${doc.document_id}: no se pudo decodificar base64 (${err instanceof Error ? err.message : String(err)}).`
    );
  }

  try {
    return await distiller.processBuffer(buffer, mimeType, doc.document_id);
  } catch (err) {
    throw new Error(
      `Documento ${doc.document_id}: fallo al extraer contenido de mime_type '${mimeType}' (${err instanceof Error ? err.message : String(err)}).`
    );
  }
}
