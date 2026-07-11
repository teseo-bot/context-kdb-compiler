import { gunzipSync, gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

export interface TarEntry {
  path: string;    // relativo, p.ej. 'paquetes/legal-esencial/machote.md'
  content: string; // UTF-8
}

/**
 * Empaqueta entries en un tar.gz determinista (formato ustar).
 *
 * Validaciones:
 * - path no vacío
 * - path no empieza con '/'
 * - path sin '\\'
 * - path sin segmentos '..'
 * - path sin NUL
 * - path byte-length UTF-8 <= 100
 * - sin paths duplicados
 *
 * Determinismo:
 * - Ordena entries por path (localeCompare 'en')
 * - mtime fijo (opts?.mtime ?? 0)
 * - gzip con timestamp fijo a 0 (bytes 4-7 y OS=Unix en byte 9)
 */
export function packTarGz(entries: TarEntry[], opts?: { mtime?: number }): Buffer {
  // Validar y normalizar
  const mtime = opts?.mtime ?? 0;
  const validatedEntries: TarEntry[] = [];
  const seenPaths = new Set<string>();

  for (const entry of entries) {
    const { path, content } = entry;

    // Validaciones
    if (path.length === 0) {
      throw new Error('Path cannot be empty');
    }
    if (path.startsWith('/')) {
      throw new Error(`Path cannot start with '/': ${path}`);
    }
    if (path.includes('\\')) {
      throw new Error(`Path cannot contain backslash: ${path}`);
    }
    if (path.includes('\0')) {
      throw new Error(`Path cannot contain NUL character: ${path}`);
    }
    if (path.split('/').some((segment) => segment === '..')) {
      throw new Error(`Path cannot contain '..' segment: ${path}`);
    }

    const pathBytes = Buffer.byteLength(path, 'utf-8');
    if (pathBytes > 100) {
      throw new Error(
        `Path byte-length UTF-8 exceeds 100: "${path}" (${pathBytes} bytes)`
      );
    }

    if (seenPaths.has(path)) {
      throw new Error(`Duplicate path: ${path}`);
    }
    seenPaths.add(path);

    validatedEntries.push(entry);
  }

  // Ordenar por path (localeCompare en)
  validatedEntries.sort((a, b) => a.path.localeCompare(b.path, 'en'));

  // Construir tar (sin comprimir)
  const tarBlocks: Buffer[] = [];

  for (const { path, content } of validatedEntries) {
    const contentBytes = Buffer.from(content, 'utf-8');
    const contentSize = contentBytes.length;

    // Crear header de 512 bytes
    const header = Buffer.alloc(512, 0);

    // offset 0, len 100: name
    const nameBytes = Buffer.from(path, 'utf-8');
    nameBytes.copy(header, 0, 0, Math.min(100, nameBytes.length));

    // offset 100, len 8: mode (0000644\0)
    Buffer.from('0000644\0', 'ascii').copy(header, 100);

    // offset 108, len 8: uid (0000000\0)
    Buffer.from('0000000\0', 'ascii').copy(header, 108);

    // offset 116, len 8: gid (0000000\0)
    Buffer.from('0000000\0', 'ascii').copy(header, 116);

    // offset 124, len 12: size (octal, 11 dígitos + \0)
    const sizeOctal = contentSize.toString(8).padStart(11, '0') + '\0';
    Buffer.from(sizeOctal, 'ascii').copy(header, 124);

    // offset 136, len 12: mtime (octal, 11 dígitos + \0)
    const mtimeOctal = mtime.toString(8).padStart(11, '0') + '\0';
    Buffer.from(mtimeOctal, 'ascii').copy(header, 136);

    // offset 148, len 8: chksum (calculado después)
    // Por ahora escribir espacios
    Buffer.from('        ', 'ascii').copy(header, 148);

    // offset 156, len 1: typeflag (0 = archivo regular)
    header[156] = 0x30; // '0'

    // offset 157, len 100: linkname (ceros)
    // ya está alloc'd

    // offset 257, len 6: magic (ustar\0)
    Buffer.from('ustar\0', 'ascii').copy(header, 257);

    // offset 263, len 2: version (00)
    Buffer.from('00', 'ascii').copy(header, 263);

    // offset 265, len 32: uname (ceros)
    // offset 297, len 32: gname (ceros)
    // offset 329, len 8: devmajor (ceros)
    // offset 337, len 8: devminor (ceros)
    // offset 345, len 155: prefix (ceros)
    // offset 500-511: ceros
    // Todo ya está inicializado

    // Calcular checksum: suma de todos los 512 bytes
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }

    // Escribir checksum en octal (6 dígitos + \0 + espacio)
    const checksumOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
    Buffer.from(checksumOctal, 'ascii').copy(header, 148);

    tarBlocks.push(header);

    // Agregar content padded a múltiplo de 512
    if (contentSize > 0) {
      tarBlocks.push(contentBytes);
      const padding = (512 - (contentSize % 512)) % 512;
      if (padding > 0) {
        tarBlocks.push(Buffer.alloc(padding, 0));
      }
    } else {
      // Content vacío: no agregar bloques, solo el header
    }
  }

  // Dos bloques de 512 ceros al final
  tarBlocks.push(Buffer.alloc(512, 0));
  tarBlocks.push(Buffer.alloc(512, 0));

  const tar = Buffer.concat(tarBlocks);

  // Comprimir con gzip
  // OJO: gzipSync guarda timestamp en bytes 4-7 del header gzip
  // Para determinismo, forzamos esos bytes a 0 después de comprimir
  // También fijamos byte 9 (OS) a 3 (Unix)
  const compressed = gzipSync(tar, { level: 9, mtime: 0 } as any);

  // Corregir el header gzip para determinismo absoluto
  if (compressed.length >= 10) {
    compressed[4] = 0;
    compressed[5] = 0;
    compressed[6] = 0;
    compressed[7] = 0;
    compressed[9] = 3; // OS = Unix
  }

  return compressed;
}

/**
 * Desempaqueta un tar.gz y retorna las entries.
 *
 * Verificaciones:
 * - Checksum de cada header
 * - Magic = 'ustar\0'
 * - typeflag = '0' o \0 (solo archivos regulares)
 *
 * Detiene al encontrar bloques de todo ceros (tolera 1 o 2 al final).
 */
export function unpackTarGz(buf: Buffer): TarEntry[] {
  const tar = gunzipSync(buf);
  const entries: TarEntry[] = [];

  let offset = 0;
  while (offset + 512 <= tar.length) {
    const headerBuf = tar.slice(offset, offset + 512);

    // Detectar bloques de todo ceros (fin del archivo)
    if (headerBuf.every((byte) => byte === 0)) {
      break;
    }

    // Leer campos del header
    const nameBytes = headerBuf.slice(0, 100);
    const nameNulIdx = nameBytes.indexOf(0);
    const name =
      nameNulIdx >= 0
        ? nameBytes.slice(0, nameNulIdx).toString('utf-8')
        : nameBytes.toString('utf-8');

    const sizeOctalStr = headerBuf.slice(124, 136).toString('ascii').trim();
    const size = parseInt(sizeOctalStr, 8);

    // Verificar checksum
    const storedChksum = headerBuf.slice(148, 156).toString('ascii').trim();
    // Recalcular: copiar header con checksum como espacios
    const headerForChksum = Buffer.alloc(512);
    headerBuf.copy(headerForChksum);
    Buffer.from('        ', 'ascii').copy(headerForChksum, 148);
    let calculatedChksum = 0;
    for (let i = 0; i < 512; i++) {
      calculatedChksum += headerForChksum[i];
    }
    const storedChksumNum = parseInt(storedChksum, 8);
    if (storedChksumNum !== calculatedChksum) {
      throw new Error(
        `Checksum mismatch for entry "${name}": expected ${storedChksumNum}, got ${calculatedChksum}`
      );
    }

    // Verificar magic
    const magic = headerBuf.slice(257, 263);
    if (!magic.toString('ascii').startsWith('ustar')) {
      throw new Error(`Invalid magic for entry "${name}"`);
    }

    // Verificar typeflag
    const typeflag = headerBuf[156];
    if (typeflag !== 0x30 && typeflag !== 0) {
      // '0' or NUL
      throw new Error(
        `Unsupported typeflag for entry "${name}": ${String.fromCharCode(typeflag)}`
      );
    }

    // Leer content
    offset += 512;
    const contentBuf = tar.slice(offset, offset + size);
    const content = contentBuf.toString('utf-8');

    entries.push({ path: name, content });

    // Avanzar al próximo bloque (padded)
    const paddedSize = size + ((512 - (size % 512)) % 512);
    offset += paddedSize;
  }

  return entries;
}
