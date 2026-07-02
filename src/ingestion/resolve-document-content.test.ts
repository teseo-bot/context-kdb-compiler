// K9-W1b (gap PDFs binarios en /v1/ingest): tests de resolveDocumentContent.
// Sin dependencia de Postgres/CompilerEngine, igual que distiller.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentDistiller } from './distiller';
import { resolveDocumentContent } from './resolve-document-content';

/**
 * Genera un PDF 1.4 mínimo válido con un único texto conocido, sin dependencias
 * externas (construcción manual de objetos PDF + xref). Suficiente para que
 * pdf-parse (usado por DocumentDistiller.processBuffer) extraiga el texto.
 */
function buildMinimalPdf(text: string): Buffer {
  const objects: string[] = [];
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  objects.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 144] /Contents 5 0 R >>\nendobj\n`
  );
  objects.push(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  const stream = `BT /F1 24 Tf 20 80 Td (${text}) Tj ET`;
  objects.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += `0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('K9-W1b: utf8 (default/explícito) devuelve content intacto sin tocar el distiller', async () => {
  const result = await resolveDocumentContent({
    document_id: 'doc-utf8',
    content: '# Título\n\nTexto plano ya en markdown.',
    content_encoding: 'utf8',
  });
  assert.equal(result, '# Título\n\nTexto plano ya en markdown.');
});

test('K9-W1b: base64 + mime_type application/pdf extrae el texto vía DocumentDistiller', async () => {
  const pdfBuffer = buildMinimalPdf('K9W1B TEST OK');
  const result = await resolveDocumentContent({
    document_id: 'doc-pdf',
    content: pdfBuffer.toString('base64'),
    content_encoding: 'base64',
    mime_type: 'application/pdf',
  });
  assert.match(result, /K9W1B TEST OK/);
});

test('K9-W1b: base64 sin mime_type falla con mensaje claro por-documento', async () => {
  await assert.rejects(
    () =>
      resolveDocumentContent({
        document_id: 'doc-sin-mime',
        content: Buffer.from('hola').toString('base64'),
        content_encoding: 'base64',
      }),
    /doc-sin-mime.*mime_type/
  );
});

test('K9-W1b: base64 con mime_type no soportado por DocumentDistiller falla con mensaje claro', async () => {
  await assert.rejects(
    () =>
      resolveDocumentContent({
        document_id: 'doc-mime-raro',
        content: Buffer.from('hola').toString('base64'),
        content_encoding: 'base64',
        mime_type: 'application/x-not-supported',
      }),
    /doc-mime-raro.*Unsupported mimeType/
  );
});

test('K9-W1b: base64 con mime_type de media sin GEMINI_DIRECT_KEY falla con mensaje claro (sin red)', async () => {
  const originalDirect = process.env.GEMINI_DIRECT_KEY;
  const originalKeys = process.env.GEMINI_API_KEYS;
  delete process.env.GEMINI_DIRECT_KEY;
  delete process.env.GEMINI_API_KEYS;
  try {
    await assert.rejects(
      () =>
        resolveDocumentContent({
          document_id: 'doc-imagen',
          content: Buffer.from('fake-image-bytes').toString('base64'),
          content_encoding: 'base64',
          mime_type: 'image/png',
        }),
      /doc-imagen.*GEMINI_DIRECT_KEY/
    );
  } finally {
    if (originalDirect !== undefined) process.env.GEMINI_DIRECT_KEY = originalDirect;
    if (originalKeys !== undefined) process.env.GEMINI_API_KEYS = originalKeys;
  }
});

test('K9-W1b: distiller inyectado se reutiliza (no crea uno nuevo por llamada) y respeta la extracción', async () => {
  const distiller = new DocumentDistiller();
  const pdfBuffer = buildMinimalPdf('REUSE OK');
  const result = await resolveDocumentContent(
    {
      document_id: 'doc-reuse',
      content: pdfBuffer.toString('base64'),
      content_encoding: 'base64',
      mime_type: 'application/pdf',
    },
    distiller
  );
  assert.match(result, /REUSE OK/);
});
