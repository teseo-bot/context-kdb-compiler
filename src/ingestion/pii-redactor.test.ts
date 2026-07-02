import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactPii, PiiLlm, PiiSpan } from './pii-redactor';

// Mock LLM que no detecta ningún span PERSONA/DIRECCION — aísla las pruebas de la pasada 1 (regex).
class NoopPiiLlm implements PiiLlm {
  async detectSpans(_text: string): Promise<PiiSpan[]> {
    return [];
  }
}

test('texto con email + teléfono + RFC → placeholders estables y pii === "redacted"', async () => {
  const input = {
    title: 'Contacto de cliente',
    description: 'Datos de contacto',
    body: 'Escribe a juan.perez@example.com o llama al 55-1234-5678. RFC: PEJJ850101ABC.',
  };

  const result = await redactPii(input, new NoopPiiLlm());

  assert.equal(result.pii, 'redacted');
  assert.match(result.body, /\[EMAIL_1\]/);
  assert.match(result.body, /\[TEL_1\]/);
  assert.match(result.body, /\[RFC_1\]/);
  assert.ok(!result.body.includes('juan.perez@example.com'));
  assert.ok(!result.body.includes('55-1234-5678'));
  assert.ok(!result.body.includes('PEJJ850101ABC'));
});

test('texto limpio (sin PII) → pii === "clean"', async () => {
  const input = {
    title: 'Proceso de ventas',
    description: 'Resumen del proceso comercial',
    body: 'El equipo comercial revisa el pipeline cada lunes y prioriza leads calificados.',
  };

  const result = await redactPii(input, new NoopPiiLlm());

  assert.equal(result.pii, 'clean');
  assert.equal(result.body, input.body);
  assert.equal(result.title, input.title);
  assert.equal(result.description, input.description);
});

test('mismo email 2 veces en el body → mismo placeholder', async () => {
  const input = {
    title: 'Seguimiento',
    description: 'Nota de seguimiento',
    body: 'Contacta a ana@empresa.com. Si no responde, reenvía a ana@empresa.com de nuevo.',
  };

  const result = await redactPii(input, new NoopPiiLlm());

  const occurrences = result.body.match(/\[EMAIL_1\]/g) ?? [];
  assert.equal(occurrences.length, 2);
  assert.ok(!result.body.includes('ana@empresa.com'));
});

test('mismo email repetido entre title y body usa el mismo placeholder (mapa compartido por draft)', async () => {
  const input = {
    title: 'Contacto: ana@empresa.com',
    description: 'Sin PII aquí',
    body: 'Escribe a ana@empresa.com para más info.',
  };

  const result = await redactPii(input, new NoopPiiLlm());

  assert.match(result.title, /\[EMAIL_1\]/);
  assert.match(result.body, /\[EMAIL_1\]/);
});

test('tarjeta que pasa Luhn se redacta; secuencia de 16 dígitos que NO pasa Luhn no se toca', async () => {
  // 4111111111111111 es un número de tarjeta de prueba válido por Luhn.
  const validCard = {
    title: 'Pago',
    description: 'Registro de pago',
    body: 'Tarjeta usada: 4111111111111111.',
  };
  const validResult = await redactPii(validCard, new NoopPiiLlm());
  assert.equal(validResult.pii, 'redacted');
  assert.match(validResult.body, /\[TARJETA_1\]/);

  const invalidCard = {
    title: 'Nota',
    description: 'Nota sin tarjeta real',
    body: 'Numero de referencia interno: 1234567890123456.',
  };
  const invalidResult = await redactPii(invalidCard, new NoopPiiLlm());
  assert.equal(invalidResult.body, invalidCard.body);
});

test('URL con query param token se redacta', async () => {
  const input = {
    title: 'Enlace',
    description: 'Enlace con token',
    body: 'Revisa https://app.example.com/reset?token=abc123 antes de que expire.',
  };
  const result = await redactPii(input, new NoopPiiLlm());
  assert.equal(result.pii, 'redacted');
  assert.match(result.body, /\[URL_1\]/);
  assert.ok(!result.body.includes('token=abc123'));
});

test('pasada LLM reemplaza spans PERSONA/DIRECCION con placeholders y marca redacted', async () => {
  class FakePersonLlm implements PiiLlm {
    async detectSpans(text: string): Promise<PiiSpan[]> {
      const idx = text.indexOf('Juan Pérez López');
      if (idx === -1) return [];
      return [{ start: idx, end: idx + 'Juan Pérez López'.length, type: 'PERSONA' }];
    }
  }

  const input = {
    title: 'Reunión',
    description: 'Notas de reunión',
    body: 'La reunión fue con Juan Pérez López sobre el contrato.',
  };

  const result = await redactPii(input, new FakePersonLlm());
  assert.equal(result.pii, 'redacted');
  assert.match(result.body, /\[PERSONA_1\]/);
  assert.ok(!result.body.includes('Juan Pérez López'));
});
