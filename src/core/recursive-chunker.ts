/**
 * Recursive Delimiter-Aware Text Chunker
 */

const DELIMITERS: string[][] = [
  ['\n\n'],                          // L0: paragraphs
  ['\n'],                            // L1: lines
  ['. ', '! ', '? ', '.\n', '!\n', '?\n'], // L2: sentences
  ['; ', ': ', ', '],                // L3: clauses
  [],                                // L4: words (whitespace split)
];

/**
 * Techo de CARACTERES, independiente del de palabras.
 *
 * `chunkSize` cuenta palabras con `/\S+/g`, y eso deja un agujero: un texto SIN espacios cuenta
 * como UNA palabra, así que `wordCount <= chunkSize` se cumple y el documento entero vuelve como
 * un solo chunk — sin llegar a intentar partirlo. Medido: 19.5 KB de texto sin espacios → 1
 * chunk, `countWords` = 1. Y el nivel L4 tampoco lo salva: `splitOnWhitespace` trocea la lista
 * de palabras, y si hay una sola palabra devuelve una sola pieza.
 *
 * No es un caso de laboratorio: el texto CJK no separa palabras con espacios, y tampoco un JSON
 * minificado, un CSV sin espacios ni un base64 pegado. Cualquiera de los cuatro puede subirlo un
 * usuario.
 *
 * Por qué duele: un chunk así recibe UN embedding de 768 dimensiones que promedia el documento
 * completo, con lo que no se parece a ninguna consulta concreta y la recuperación devuelve
 * irrelevancias; y lo que pase del límite de entrada del modelo se trunca EN SILENCIO. 8000 es el
 * mismo tope que ya aplican `indexing/indexer.ts` y `partners/publisher.ts` (MAX_EMBED_INPUT_CHARS)
 * por esta misma razón.
 */
const MAX_CHUNK_CHARS = 8000;

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface TextChunk {
  text: string;
  index: number;
}

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const chunkSize = opts?.chunkSize || 300;
  const chunkOverlap = opts?.chunkOverlap || 50;

  if (!text || text.trim().length === 0) return [];

  // El atajo de «cabe entero» exige las DOS condiciones: pocas palabras Y pocos caracteres. Con
  // sólo la de palabras, un texto sin espacios se devolvía completo (ver MAX_CHUNK_CHARS).
  const wordCount = countWords(text);
  if (wordCount <= chunkSize && text.length <= MAX_CHUNK_CHARS) {
    return [{ text: text.trim(), index: 0 }];
  }

  const pieces = recursiveSplit(text, 0, chunkSize);
  const merged = greedyMerge(pieces, chunkSize);
  const withOverlap = applyOverlap(merged, chunkOverlap);
  // Pasada final: el solapamiento añade palabras DESPUÉS de la mezcla, así que el techo se
  // impone al resultado y no a mitad del proceso. Así la invariante es absoluta y comprobable:
  // ningún chunk que salga de aquí supera MAX_CHUNK_CHARS, venga el texto como venga.
  const acotados = withOverlap.flatMap((t) => hardSplitByChars(t, MAX_CHUNK_CHARS));

  return acotados.map((t, i) => ({ text: t.trim(), index: i })).filter((c) => c.text.length > 0);
}

function recursiveSplit(text: string, level: number, target: number): string[] {
  if (level >= DELIMITERS.length) {
    return splitOnWhitespace(text, target);
  }

  const delimiters = DELIMITERS[level];
  if (delimiters.length === 0) {
    return splitOnWhitespace(text, target);
  }

  const pieces = splitAtDelimiters(text, delimiters);

  if (pieces.length <= 1) {
    return recursiveSplit(text, level + 1, target);
  }

  const result: string[] = [];
  for (const piece of pieces) {
    if (countWords(piece) > target) {
      result.push(...recursiveSplit(piece, level + 1, target));
    } else {
      result.push(piece);
    }
  }

  return result;
}

function splitAtDelimiters(text: string, delimiters: string[]): string[] {
  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliest = -1;
    let earliestDelim = '';

    for (const delim of delimiters) {
      const idx = remaining.indexOf(delim);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestDelim = delim;
      }
    }

    if (earliest === -1) {
      pieces.push(remaining);
      break;
    }

    const piece = remaining.slice(0, earliest + earliestDelim.length);
    if (piece.trim().length > 0) {
      pieces.push(piece);
    }
    remaining = remaining.slice(earliest + earliestDelim.length);
  }

  return pieces.filter(p => p.trim().length > 0);
}

function splitOnWhitespace(text: string, target: number): string[] {
  const words = text.match(/\S+\s*/g) || [];
  if (words.length === 0) return [];

  // Con una sola «palabra» no hay nada que trocear por espacios y este nivel devolvía el texto
  // entero — el fondo del agujero de MAX_CHUNK_CHARS. Aquí es donde tiene que morir.
  if (words.length === 1) {
    return hardSplitByChars(text, MAX_CHUNK_CHARS);
  }

  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += target) {
    const slice = words.slice(i, i + target).join('');
    if (slice.trim().length > 0) {
      // Una sola palabra puede pasarse del techo por sí misma (un base64 de 30 KB sin espacios
      // pegado a otras palabras), así que el tramo también se acota.
      pieces.push(...hardSplitByChars(slice, MAX_CHUNK_CHARS));
    }
  }
  return pieces;
}

/**
 * Corte duro por caracteres: el último recurso, cuando no hay NINGÚN separador que aprovechar.
 * Prefiere cortar en el último espacio del tramo para no partir una palabra por la mitad, y si no
 * hay espacio ninguno (texto CJK, base64, JSON minificado) corta en seco — que es exactamente el
 * caso que dejaba pasar el documento completo como un chunk.
 */
function hardSplitByChars(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const pieces: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const tramo = remaining.slice(0, maxChars);
    const ultimoEspacio = tramo.search(/\s\S*$/);
    // Sólo se respeta el espacio si no deja un trozo ridículo: por debajo de la mitad del tope
    // preferimos el corte en seco antes que generar muchos chunks minúsculos.
    const corte = ultimoEspacio > maxChars / 2 ? ultimoEspacio : maxChars;
    pieces.push(remaining.slice(0, corte));
    remaining = remaining.slice(corte);
  }
  if (remaining.length > 0) pieces.push(remaining);
  return pieces;
}

function greedyMerge(pieces: string[], target: number): string[] {
  if (pieces.length === 0) return [];

  const result: string[] = [];
  let current = pieces[0];

  for (let i = 1; i < pieces.length; i++) {
    const combined = current + pieces[i];
    // El techo de caracteres entra también aquí: si no, la mezcla podría reconstruir un chunk
    // gigante a partir de piezas que sí se habían partido bien.
    if (countWords(combined) <= Math.ceil(target * 1.5) && combined.length <= MAX_CHUNK_CHARS) {
      current = combined;
    } else {
      result.push(current);
      current = pieces[i];
    }
  }

  if (current.trim().length > 0) {
    result.push(current);
  }

  return result;
}

function applyOverlap(chunks: string[], overlapWords: number): string[] {
  if (chunks.length <= 1 || overlapWords <= 0) return chunks;

  const result: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prevTrailing = extractTrailingContext(chunks[i - 1], overlapWords);
    result.push(prevTrailing + chunks[i]);
  }

  return result;
}

function extractTrailingContext(text: string, targetWords: number): string {
  const words = text.match(/\S+\s*/g) || [];
  if (words.length <= targetWords) return '';

  const trailing = words.slice(-targetWords).join('');

  const sentenceStart = trailing.search(/[.!?]\s+/);
  if (sentenceStart !== -1 && sentenceStart < trailing.length / 2) {
    const afterSentence = trailing.slice(sentenceStart).replace(/^[.!?]\s+/, '');
    if (afterSentence.trim().length > 0) {
      return afterSentence;
    }
  }

  return trailing;
}

function countWords(text: string): number {
  return (text.match(/\S+/g) || []).length;
}