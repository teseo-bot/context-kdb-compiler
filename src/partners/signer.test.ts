import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify as cryptoVerify } from 'node:crypto';
import { canonicalize, verifyManifest, signManifest } from './signer';

// PA2-W2: Test KMS simulado con pares de llaves locales
test('canonicalize: JSON estable ante orden distinto de claves', () => {
  const obj1 = { z: 1, a: 2, m: { b: 3, x: 4 } };
  const obj2 = { a: 2, z: 1, m: { x: 4, b: 3 } };

  const canon1 = canonicalize(obj1);
  const canon2 = canonicalize(obj2);

  assert.equal(canon1, canon2, 'canonicalize produce el mismo resultado para objetos con claves distintas');
});

test('canonicalize: termina con LF y UTF-8', () => {
  const obj = { x: 'ñ', y: 2 };
  const canon = canonicalize(obj);

  assert.ok(canon.endsWith('\n'), 'canonicalize termina con LF');
  // Verificar UTF-8 (ñ = U+00F1)
  const buffer = Buffer.from(canon, 'utf-8');
  assert.ok(buffer.includes(Buffer.from([0xc3, 0xb1])), 'Carácter ñ codificado en UTF-8');
});

test('canonicalize: excluye campos de firma (manifest_sha256, signature_b64, kms_key_version)', () => {
  const objWithSignature = {
    package_id: 'pkg-123',
    version: 1,
    manifest_sha256: 'abc123',
    signature_b64: 'def456',
    kms_key_version: 'v1',
  };

  const objWithout = {
    package_id: 'pkg-123',
    version: 1,
  };

  const canonWithSignature = canonicalize(objWithSignature);
  const canonWithout = canonicalize(objWithout);

  assert.equal(canonWithSignature, canonWithout, 'canonicalize excluye campos de firma');
});

test('signManifest + verifyManifest: firma→verifica → verified', () => {
  // Generar par de llaves local (no real KMS)
  const { privateKey, publicKey } = require('node:crypto').generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', // P-256
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Objeto de manifiesto
  const manifest = {
    package_id: '550e8400-e29b-41d4-a716-446655440001',
    package_slug: 'contratos-mercantiles',
    version: 1,
    concepts: [{ path: '@bufete/l-legal/clausula.md', sha256: 'abc123' }],
  };

  // Canonicalizar
  const canonical = canonicalize(manifest);

  // Firmar localmente (simulando KMS)
  const signer = require('node:crypto').createSign('sha256');
  signer.update(canonical, 'utf-8');
  const signatureB64 = signer.sign(privateKey, 'base64');

  // Computar SHA256
  const sha256Hex = require('node:crypto').createHash('sha256').update(canonical, 'utf-8').digest('hex');

  // Crear manifiesto firmado
  const signedManifest = {
    ...manifest,
    manifest_sha256: sha256Hex,
    signature_b64: signatureB64,
    kms_key_version: 'projects/test/locations/us-central1/keyRings/test/cryptoKeys/test/versions/1',
  };

  // Verificar
  const result = verifyManifest(signedManifest, publicKey);

  assert.equal(result, 'verified', 'verifyManifest devuelve verified para firma válida');
});

test('verifyManifest: alterar 1 byte del manifest → unverified', () => {
  // Generar par de llaves
  const { privateKey, publicKey } = require('node:crypto').generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const manifest = {
    package_id: '550e8400-e29b-41d4-a716-446655440001',
    concepts: [{ path: '@bufete/l-legal/clausula.md', sha256: 'abc123' }],
  };

  const canonical = canonicalize(manifest);

  // Firmar
  const signer = require('node:crypto').createSign('sha256');
  signer.update(canonical, 'utf-8');
  const signatureB64 = signer.sign(privateKey, 'base64');

  const sha256Hex = require('node:crypto').createHash('sha256').update(canonical, 'utf-8').digest('hex');

  const signedManifest = {
    ...manifest,
    manifest_sha256: sha256Hex,
    signature_b64: signatureB64,
    kms_key_version: 'v1',
  };

  // Alterar el manifiesto (cambiar version o concepto)
  const tamperedManifest = {
    ...signedManifest,
    concepts: [{ path: '@bufete/l-legal/clausula-MODIFICADA.md', sha256: 'abc123' }],
  };

  // Verificar (debe fallar porque se modificó pero el SHA256 es el original)
  const result = verifyManifest(tamperedManifest, publicKey);

  assert.equal(result, 'unverified', 'verifyManifest devuelve unverified cuando el contenido está alterado');
});

test('verifyManifest: SHA256 inválido → unverified', () => {
  const { publicKey } = require('node:crypto').generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const manifest = {
    package_id: '550e8400-e29b-41d4-a716-446655440001',
    manifest_sha256: 'invalid_sha256_here',
    signature_b64: 'invalid_signature',
    kms_key_version: 'v1',
  };

  const result = verifyManifest(manifest, publicKey);

  assert.equal(result, 'unverified', 'verifyManifest devuelve unverified cuando SHA256 es inválido');
});

test('verifyManifest: missing signature_b64 → unverified', () => {
  const { publicKey } = require('node:crypto').generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const manifest = {
    package_id: '550e8400-e29b-41d4-a716-446655440001',
    manifest_sha256: 'abc123',
    // signature_b64 faltante
    kms_key_version: 'v1',
  };

  const result = verifyManifest(manifest, publicKey);

  assert.equal(result, 'unverified', 'verifyManifest devuelve unverified cuando falta signature_b64');
});
