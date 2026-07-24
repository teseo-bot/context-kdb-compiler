/**
 * NOM-151 — Adaptador de conservación PROPIO (`kms-timestamp`).
 *
 * Emite un registro de conservación TÉCNICO auto-firmado: sella una aserción
 * `{message_sha256, subject_ref, timestamp, ...}` con una llave KMS de Teseo (EC_SIGN_P256).
 * Reutiliza las primitivas de la capa A (`canonicalize` + `signManifest` de `signer.ts`) — la
 * capa D COMPLEMENTA la A con las mismas garantías criptográficas + fecha cierta del reloj.
 *
 * ⚠️ `legal_grade: 'technical'`. Esto NO es una constancia NOM-159 acreditada: el sello de tiempo
 * proviene de NUESTRO reloj de servidor, no de una TSA acreditada por la Secretaría de Economía.
 * Es evidencia pericial sólida (integridad + fecha auto-declarada verificable), útil desde el día
 * 1 sin contratar PSC. Para valor probatorio pleno se usa el proveedor `psc-externo`.
 *
 * Diseño testeable: mismo patrón que `signer.ts`/`publisher.ts` — todo lo no-determinista
 * (reloj, KMS) es inyectable. Los tests firman con un par EC local vía `signManifestFn`.
 */

import { KeyManagementServiceClient } from '@google-cloud/kms';
import { createHash, createVerify } from 'node:crypto';
import { canonicalize, signManifest, KmsClient } from './signer';
import {
  SignAndPreserve,
  PreservationSubject,
  Constancia,
  PreservationVerification,
  assertionOf,
} from './preservation';

export interface KmsTimestampDeps {
  /**
   * Recurso de la VERSIÓN de llave KMS de sellado (distinta de las llaves por-aliado que firman
   * CONTENIDO: esta llave sella TIEMPO, es un servicio único de Teseo). Default: `NOM151_KMS_KEY`.
   * Ej: projects/<p>/locations/<l>/keyRings/<kr>/cryptoKeys/nom151-timestamp/cryptoKeyVersions/1
   */
  keyId?: string;
  /** Reloj inyectable (test). Default: `() => new Date()`. */
  now?: () => Date;
  /** Cliente KMS real (default) o fake. */
  kmsClient?: KmsClient;
  /** Firma inyectable (test): reemplaza `signManifest` para firmar con un par EC local. */
  signManifestFn?: typeof signManifest;
  /**
   * Resuelve el PEM de la llave pública para `verify()`. Default: consulta KMS por el
   * `issuer` (versión de llave) de la constancia. Los tests inyectan el PEM local.
   */
  resolvePublicKeyPem?: (keyVersion: string) => Promise<string>;
}

export class KmsTimestampPreserver implements SignAndPreserve {
  readonly provider = 'kms-timestamp' as const;
  readonly legalGrade = 'technical' as const;

  private readonly deps: KmsTimestampDeps;

  constructor(deps: KmsTimestampDeps = {}) {
    this.deps = deps;
  }

  private keyId(): string {
    const k = this.deps.keyId ?? process.env.NOM151_KMS_KEY;
    if (!k) {
      throw new Error(
        'NOM151_KMS_KEY no configurada: el adaptador `kms-timestamp` requiere la versión de ' +
          'llave KMS de sellado para emitir la constancia.'
      );
    }
    return k;
  }

  async preserve(subject: PreservationSubject): Promise<Constancia> {
    const now = this.deps.now ?? (() => new Date());
    const signFn = this.deps.signManifestFn ?? signManifest;

    const timestamp = now().toISOString();
    // La ASERCIÓN firmada — solo campos de conservación, sin envoltura (proof/issuer/legal_grade).
    const assertion = assertionOf({
      constancia_version: '1',
      message_sha256: subject.message_sha256,
      subject_ref: subject.ref,
      timestamp,
      timestamp_source: 'kms-server',
      provider: this.provider,
    });

    const canonical = canonicalize(assertion);
    const sig = await signFn(canonical, this.keyId(), this.deps.kmsClient);

    return {
      constancia_version: '1',
      message_sha256: subject.message_sha256,
      subject_ref: subject.ref,
      timestamp,
      timestamp_source: 'kms-server',
      provider: this.provider,
      legal_grade: this.legalGrade,
      proof: {
        type: 'kms-ecdsa-p256',
        value_b64: sig.signature_b64,
        // `assertion_sha256` == el digest que KMS firmó; útil para auditoría/depuración.
        meta: { assertion_sha256: sig.manifest_sha256 },
      },
      issuer: sig.kms_key_version,
    };
  }

  async verify(constancia: Constancia): Promise<PreservationVerification> {
    try {
      if (constancia.provider !== this.provider) {
        return {
          status: 'unsupported',
          reason: `Constancia de proveedor '${constancia.provider}', no verificable por kms-timestamp.`,
        };
      }

      const resolvePem =
        this.deps.resolvePublicKeyPem ??
        (async (keyVersion: string): Promise<string> => {
          const client = (this.deps.kmsClient as any) ?? new KeyManagementServiceClient();
          const [pub] = await client.getPublicKey({ name: keyVersion });
          return pub.pem as string;
        });

      const publicKeyPem = await resolvePem(constancia.issuer);

      // Recanonicalizar la aserción EXACTA que se firmó y verificar la firma ECDSA P-256+SHA256.
      const canonical = canonicalize(assertionOf(constancia));

      // Chequeo de coherencia: el digest de la aserción debe coincidir con el registrado.
      const expectedDigest = createHash('sha256').update(canonical, 'utf-8').digest('hex');
      const recordedDigest = constancia.proof.meta?.assertion_sha256;
      if (typeof recordedDigest === 'string' && recordedDigest !== expectedDigest) {
        return { status: 'unverified', reason: 'assertion_sha256 no coincide con la aserción canónica.' };
      }

      const signature = Buffer.from(constancia.proof.value_b64, 'base64');
      const verifier = createVerify('sha256');
      verifier.update(canonical, 'utf-8');
      return verifier.verify(publicKeyPem, signature)
        ? { status: 'verified' }
        : { status: 'unverified', reason: 'La firma KMS no verifica contra la llave pública.' };
    } catch (error) {
      return {
        status: 'unverified',
        reason: `Excepción durante la verificación: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
