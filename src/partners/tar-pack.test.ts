import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createWriteStream, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packTarGz, unpackTarGz, TarEntry } from './tar-pack';

test('Round-trip: 3 entries (vacío, multilínea UTF-8, 512 bytes)', async (t) => {
  const entries: TarEntry[] = [
    { path: 'archivo1.txt', content: '' },
    {
      path: 'archivo2.md',
      content: 'áéí\n😀 fin',
    },
    {
      path: 'archivo3.bin',
      content: 'x'.repeat(512),
    },
  ];

  const packed = packTarGz(entries);
  const unpacked = unpackTarGz(packed);

  // Ordenar por path para comparación
  const sortedExpected = [...entries].sort((a, b) =>
    a.path.localeCompare(b.path, 'en')
  );

  assert.equal(unpacked.length, sortedExpected.length);
  for (let i = 0; i < unpacked.length; i++) {
    assert.equal(unpacked[i].path, sortedExpected[i].path);
    assert.equal(unpacked[i].content, sortedExpected[i].content);
  }
});

test('Determinismo: dos llamadas idénticas → mismos bytes y sha256', async (t) => {
  const entries: TarEntry[] = [
    { path: 'a.txt', content: 'contenido A' },
    { path: 'b.txt', content: 'contenido B' },
    { path: 'c.txt', content: 'contenido C' },
  ];

  const packed1 = packTarGz(entries);
  const packed2 = packTarGz(entries);

  // Bytes idénticos
  assert.equal(Buffer.compare(packed1, packed2), 0);

  // SHA256 idéntico
  const sha1 = createHash('sha256').update(packed1).digest('hex');
  const sha2 = createHash('sha256').update(packed2).digest('hex');
  assert.equal(sha1, sha2);
});

test('Determinismo: cambiar ORDEN de entrada → mismos bytes (sort canónico)', async (t) => {
  const entries1: TarEntry[] = [
    { path: 'z.txt', content: 'Z' },
    { path: 'a.txt', content: 'A' },
    { path: 'm.txt', content: 'M' },
  ];

  const entries2: TarEntry[] = [
    { path: 'a.txt', content: 'A' },
    { path: 'm.txt', content: 'M' },
    { path: 'z.txt', content: 'Z' },
  ];

  const packed1 = packTarGz(entries1);
  const packed2 = packTarGz(entries2);

  assert.equal(Buffer.compare(packed1, packed2), 0);

  const sha1 = createHash('sha256').update(packed1).digest('hex');
  const sha2 = createHash('sha256').update(packed2).digest('hex');
  assert.equal(sha1, sha2);
});

test('Validación: path absoluto lanza error', async (t) => {
  const entries: TarEntry[] = [{ path: '/abs.md', content: 'data' }];

  assert.throws(
    () => packTarGz(entries),
    (err: Error) => err.message.includes('cannot start with')
  );
});

test('Validación: path con .. lanza error', async (t) => {
  const entries: TarEntry[] = [{ path: 'a/../b.md', content: 'data' }];

  assert.throws(
    () => packTarGz(entries),
    (err: Error) => err.message.includes("'..'")
  );
});

test('Validación: path con backslash lanza error', async (t) => {
  const entries: TarEntry[] = [{ path: 'a\\b.md', content: 'data' }];

  assert.throws(
    () => packTarGz(entries),
    (err: Error) => err.message.includes('backslash')
  );
});

test('Validación: path vacío lanza error', async (t) => {
  const entries: TarEntry[] = [{ path: '', content: 'data' }];

  assert.throws(
    () => packTarGz(entries),
    (err: Error) => err.message.includes('empty')
  );
});

test('Validación: path > 100 bytes UTF-8 lanza error', async (t) => {
  const entries: TarEntry[] = [{ path: 'x'.repeat(101), content: 'data' }];

  assert.throws(
    () => packTarGz(entries),
    (err: Error) => err.message.includes('exceeds 100')
  );
});

test('Validación: paths duplicados lanza error', async (t) => {
  const entries: TarEntry[] = [
    { path: 'a.md', content: 'first' },
    { path: 'a.md', content: 'second' },
  ];

  assert.throws(
    () => packTarGz(entries),
    (err: Error) => err.message.includes('Duplicate')
  );
});

test('Estructura binaria: header ustar correcto', async (t) => {
  const entries: TarEntry[] = [{ path: 'a.txt', content: 'hola' }];

  const packed = packTarGz(entries);
  const tar = gunzipSync(packed);

  // Total: 512 (header) + 512 (content padded) + 512*2 (bloques cero) = 2048
  assert.equal(tar.length, 2048);

  const header = tar.slice(0, 512);

  // byte 156 === 0x30 ('0')
  assert.equal(header[156], 0x30);

  // campo size (124..135) === '00000000004\0'
  const sizeField = header.slice(124, 136).toString('ascii');
  assert.equal(sizeField, '00000000004\0');

  // magic en 257 === 'ustar\0'
  const magic = header.slice(257, 263).toString('ascii');
  assert.equal(magic, 'ustar\0');
});

test('Interop con bsdtar del sistema: tar -tzf lista archivos', async (t) => {
  const tempdir = mkdtempSync(join(tmpdir(), 'tar-pack-test-'));

  try {
    const entries: TarEntry[] = [
      { path: 'file1.txt', content: 'contenido 1' },
      { path: 'subdir/file2.txt', content: 'contenido 2' },
      { path: 'empty.txt', content: '' },
    ];

    const packed = packTarGz(entries);
    const tarFile = join(tempdir, 'test.tar.gz');

    // Escribir a archivo
    const fs = await import('node:fs');
    fs.writeFileSync(tarFile, packed);

    // tar -tzf
    const listOutput = execSync(`tar -tzf "${tarFile}"`, {
      encoding: 'utf-8',
    });
    const listedFiles = listOutput
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);

    const expectedPaths = entries.map((e) => e.path).sort();
    const actualPaths = listedFiles.sort();

    assert.deepEqual(actualPaths, expectedPaths);

    // tar -xzf a directorio temporal y verificar contenido
    const extractDir = mkdtempSync(join(tmpdir(), 'tar-pack-extract-'));
    try {
      execSync(`tar -xzf "${tarFile}" -C "${extractDir}"`);

      for (const entry of entries) {
        const filePath = join(extractDir, entry.path);
        const extractedContent = fs.readFileSync(filePath, 'utf-8');
        assert.equal(extractedContent, entry.content);
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tempdir, { recursive: true, force: true });
  }
});

test('Checksum corrupto: unpackTarGz lanza error', async (t) => {
  const entries: TarEntry[] = [{ path: 'a.txt', content: 'data' }];

  const packed = packTarGz(entries);
  const tar = gunzipSync(packed);

  // Corromper un byte del header (byte 0)
  tar[0] = 0xff;

  // Re-comprimir
  const { gzipSync } = await import('node:zlib');
  const corruptedPacked = gzipSync(tar, { level: 9 } as any);

  // Fijar gzip header para determinismo (aunque será corrupto al descomprimir)
  if (corruptedPacked.length >= 10) {
    corruptedPacked[4] = 0;
    corruptedPacked[5] = 0;
    corruptedPacked[6] = 0;
    corruptedPacked[7] = 0;
    corruptedPacked[9] = 3;
  }

  // unpackTarGz debe lanzar por checksum inválido
  assert.throws(
    () => unpackTarGz(corruptedPacked),
    (err: Error) => err.message.includes('Checksum mismatch')
  );
});
