/**
 * NOM-151 — Tests del seam `SignAndPreserve` (adaptadores propio + PSC stub + factory).
 *
 * KMS se simula con un par EC P-256 local (mismo patrón que signer.test.ts): un `signManifestFn`
 * inyectado firma la aserción canónica con `createSign`, y `resolvePublicKeyPem` devuelve el PEM
 * público — así el round-trip preserve→verify se prueba sin KMS real.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';

import { resolvePreserver, PscNotConfiguredError, Constancia } from './preservation';
import { KmsTimestampPreserver } from './preservation-kms-timestamp';
import { PscExternoPreserver, PscSubmitResponse } from './preservation-psc-externo';
import { signManifest } from './signer';

const FIXED_KEY_VERSION =
  'projects/test/locations/us-central1/keyRings/test/cryptoKeys/nom151-timestamp/cryptoKeyVersions/1';

/** Par EC local + un `signManifestFn` que firma el canónico como lo haría KMS (ECDSA P-256/SHA256). */
function localKmsFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const signManifestFn: typeof signManifest = async (canonicalJson) => {
    const signer = createSign('sha256');
    signer.update(canonicalJson, 'utf-8');
    return {
      manifest_sha256: createHash('sha256').update(canonicalJson, 'utf-8').digest('hex'),
      signature_b64: signer.sign(privateKey, 'base64'),
      kms_key_version: FIXED_KEY_VERSION,
    };
  };
  return { publicKeyPem: publicKey as string, signManifestFn };
}

function kmsPreserver() {
  const { publicKeyPem, signManifestFn } = localKmsFixture();
  return new KmsTimestampPreserver({
    keyId: FIXED_KEY_VERSION,
    now: () => new Date('2026-07-23T18:00:00.000Z'),
    signManifestFn,
    resolvePublicKeyPem: async () => publicKeyPem,
  });
}

const SUBJECT = {
  ref: 'partner:bufete-demo/package:contratos-mercantiles/v1',
  message_sha256: 'a'.repeat(64),
};

// ==================== kms-timestamp (propio) ====================

test('kms-timestamp: preserve emite constancia técnica con la forma esperada', async () => {
  const c = await kmsPreserver().preserve(SUBJECT);
  assert.equal(c.constancia_version, '1');
  assert.equal(c.provider, 'kms-timestamp');
  assert.equal(c.legal_grade, 'technical', 'nunca finge acreditación PSC');
  assert.equal(c.message_sha256, SUBJECT.message_sha256);
  assert.equal(c.subject_ref, SUBJECT.ref);
  assert.equal(c.timestamp, '2026-07-23T18:00:00.000Z', 'fecha cierta = reloj inyectado');
  assert.equal(c.timestamp_source, 'kms-server');
  assert.equal(c.proof.type, 'kms-ecdsa-p256');
  assert.ok(c.proof.value_b64.length > 0, 'firma presente');
  assert.equal(c.issuer, FIXED_KEY_VERSION);
});

test('kms-timestamp: preserve → verify → verified (round trip)', async () => {
  const p = kmsPreserver();
  const c = await p.preserve(SUBJECT);
  const v = await p.verify(c);
  assert.equal(v.status, 'verified', v.reason);
});

test('kms-timestamp: alterar message_sha256 tras firmar → unverified', async () => {
  const p = kmsPreserver();
  const c = await p.preserve(SUBJECT);
  const tampered: Constancia = { ...c, message_sha256: 'b'.repeat(64) };
  const v = await p.verify(tampered);
  assert.equal(v.status, 'unverified');
});

test('kms-timestamp: alterar timestamp tras firmar → unverified', async () => {
  const p = kmsPreserver();
  const c = await p.preserve(SUBJECT);
  const tampered: Constancia = { ...c, timestamp: '2020-01-01T00:00:00.000Z' };
  const v = await p.verify(tampered);
  assert.equal(v.status, 'unverified', 'no se puede antedatar la fecha cierta sin romper la firma');
});

test('kms-timestamp: verify de una constancia de otro proveedor → unsupported', async () => {
  const c = await kmsPreserver().preserve(SUBJECT);
  const other: Constancia = { ...c, provider: 'psc-externo' };
  const v = await kmsPreserver().verify(other);
  assert.equal(v.status, 'unsupported');
});

// ==================== psc-externo (stub, fail-closed) ====================

test('psc-externo: preserve sin configurar → lanza PscNotConfiguredError (fail-closed)', async () => {
  const p = new PscExternoPreserver();
  await assert.rejects(() => p.preserve(SUBJECT), PscNotConfiguredError);
});

test('psc-externo: endpoint configurado pero sin cliente submit → sigue fail-closed', async () => {
  const p = new PscExternoPreserver({ endpoint: 'https://psc.example/api', providerName: 'mifiel' });
  await assert.rejects(() => p.preserve(SUBJECT), PscNotConfiguredError);
});

test('psc-externo: con submit inyectado emite constancia acreditada', async () => {
  const fakeResp: PscSubmitResponse = {
    timestamp: '2026-07-23T18:05:00.000Z',
    token_b64: Buffer.from('rfc3161-token').toString('base64'),
    proof_type: 'rfc3161',
    issuer: 'PSC Mifiel — acreditación SE 123',
  };
  const p = new PscExternoPreserver({ submit: async () => fakeResp });
  const c = await p.preserve(SUBJECT);
  assert.equal(c.provider, 'psc-externo');
  assert.equal(c.legal_grade, 'psc-accredited');
  assert.equal(c.timestamp_source, 'psc-tsa');
  assert.equal(c.timestamp, fakeResp.timestamp);
  assert.equal(c.proof.type, 'rfc3161');
  assert.equal(c.issuer, fakeResp.issuer);
});

test('psc-externo: verify sin verifyToken → unsupported (requiere cert del PSC)', async () => {
  const p = new PscExternoPreserver({ submit: async () => ({
    timestamp: '2026-07-23T18:05:00.000Z',
    token_b64: 'x',
    proof_type: 'rfc3161',
    issuer: 'PSC',
  }) });
  const c = await p.preserve(SUBJECT);
  const v = await p.verify(c);
  assert.equal(v.status, 'unsupported');
});

// ==================== factory / selección agnóstica ====================

test('resolvePreserver: default → kms-timestamp', () => {
  const prev = process.env.NOM151_PROVIDER;
  delete process.env.NOM151_PROVIDER;
  try {
    assert.equal(resolvePreserver().provider, 'kms-timestamp');
  } finally {
    if (prev !== undefined) process.env.NOM151_PROVIDER = prev;
  }
});

test('resolvePreserver: provider explícito psc-externo', () => {
  assert.equal(resolvePreserver({ provider: 'psc-externo' }).provider, 'psc-externo');
});

test('resolvePreserver: respeta NOM151_PROVIDER del entorno', () => {
  const prev = process.env.NOM151_PROVIDER;
  process.env.NOM151_PROVIDER = 'psc-externo';
  try {
    assert.equal(resolvePreserver().provider, 'psc-externo');
  } finally {
    if (prev === undefined) delete process.env.NOM151_PROVIDER;
    else process.env.NOM151_PROVIDER = prev;
  }
});

test('resolvePreserver: proveedor desconocido → error', () => {
  assert.throws(() => resolvePreserver({ provider: 'no-existe' as any }));
});
