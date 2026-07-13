/**
 * PA2-W2: Firma KMS de manifiestos de paquetes de aliado
 * Canonicalización, provisión de llave, firma y verificación
 */

import { createHash, createVerify } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';

/**
 * Canonicaliza un objeto JSON para firma:
 * - Ordena claves recursivamente
 * - Excluye campos de firma (manifest_sha256, signature_b64, kms_key_version)
 * - Compacto (sin espacios)
 * - LF para separadores de línea
 * - UTF-8
 */
export function canonicalize(obj: Record<string, any>): string {
  function sortKeys(o: any): any {
    if (Array.isArray(o)) {
      return o.map(sortKeys);
    } else if (o !== null && typeof o === 'object') {
      // Excluir campos de firma
      const filtered = Object.keys(o)
        .filter(k => !['manifest_sha256', 'signature_b64', 'kms_key_version'].includes(k))
        .sort()
        .reduce((result, key) => {
          result[key] = sortKeys(o[key]);
          return result;
        }, {} as Record<string, any>);
      return filtered;
    }
    return o;
  }

  const sorted = sortKeys(obj);
  const canonical = JSON.stringify(sorted, null, 0); // Compacto, sin espacios
  // Asegurar LF y UTF-8
  return canonical + '\n';
}

/**
 * Cliente KMS inyectable para tests
 */
export interface KmsClient {
  getKeyVersion(request: any): Promise<any>;
  createCryptoKey(request: any): Promise<any>;
  createCryptoKeyVersion(request: any): Promise<any>;
  asymmetricSign(request: any): Promise<any>;
  getPublicKey(request: any): Promise<any>;
}

/**
 * Provisiona una llave de firma en Cloud KMS
 * Idempotente: si la llave ya existe, devuelve la existente
 * @param slug - slug del partner (p.ej. "bufete-demo")
 * @param kmsClient - cliente KMS inyectable
 */
export async function provisionPartnerKey(
  slug: string,
  kmsClient?: KmsClient
): Promise<string> {
  const client = kmsClient || new KeyManagementServiceClient();
  const keyring = process.env.KMS_PARTNER_KEYRING;

  if (!keyring) {
    throw new Error('KMS_PARTNER_KEYRING environment variable not set');
  }

  const keyId = `partner-${slug}`;
  const keyPath = `${keyring}/cryptoKeys/${keyId}`;

  try {
    // Intentar obtener la llave existente
    const [key] = await (client as any).getCryptoKey({ name: keyPath });
    console.log(`[kms] Llave ${keyId} ya existe`);
    return keyPath;
  } catch (error: any) {
    // Si no existe (404), crearla
    if (error?.code === 404 || error?.code === 5) {
      console.log(`[kms] Creando llave ${keyId}`);
      const createRequest = {
        parent: keyring,
        cryptoKeyId: keyId,
        cryptoKey: {
          purpose: 'ASYMMETRIC_SIGN',
          versionTemplate: {
            algorithm: 'EC_SIGN_P256_SHA256',
          },
        },
      };

      const [key] = await (client as any).createCryptoKey(createRequest);
      console.log(`[kms] Llave ${keyId} creada exitosamente`);
      return key.name;
    }

    throw error;
  }
}

/**
 * Firma un JSON canónico con la llave del aliado
 * Devuelve {manifest_sha256, signature_b64, kms_key_version}
 */
export async function signManifest(
  canonicalJson: string,
  keyId: string,
  kmsClient?: KmsClient
): Promise<{
  manifest_sha256: string;
  signature_b64: string;
  kms_key_version: string;
}> {
  const client = kmsClient || new KeyManagementServiceClient();

  // Computar SHA256 del canónico
  const digest = createHash('sha256').update(canonicalJson, 'utf-8').digest();

  // Firmar con KMS
  const signRequest = {
    name: keyId,
    digest: { sha256: digest },
  };

  const [signResponse] = await (client as any).asymmetricSign(signRequest);

  const signature = Buffer.from(signResponse.signature).toString('base64');
  const kmsKeyVersion = signResponse.name; // p.ej. "projects/.../cryptoKeys/.../versions/1"

  const manifestSha256 = digest.toString('hex');

  return {
    manifest_sha256: manifestSha256,
    signature_b64: signature,
    kms_key_version: kmsKeyVersion,
  };
}

/**
 * Verifica un manifiesto firmado
 * Recanonicaliza el manifiesto (excluyendo campos de firma),
 * recomputa el SHA256, y verifica la firma con la llave pública.
 * Devuelve 'verified' o 'unverified' (jamás lanza excepciones)
 */
export function verifyManifest(
  manifest: Record<string, any>,
  publicKeyPem: string
): 'verified' | 'unverified' {
  try {
    // Recanonicalizar (excluyendo campos de firma)
    const recanonical = canonicalize(manifest);

    // Recomputar SHA256
    const computedSha256 = createHash('sha256').update(recanonical, 'utf-8').digest('hex');

    // Verificar que el SHA256 en el manifiesto coincida
    if (manifest.manifest_sha256 !== computedSha256) {
      console.warn('[verify] SHA256 mismatch');
      return 'unverified';
    }

    // Extraer la firma
    const signatureB64 = manifest.signature_b64;
    if (!signatureB64 || typeof signatureB64 !== 'string') {
      console.warn('[verify] Missing or invalid signature_b64');
      return 'unverified';
    }

    // Decodificar firma de base64
    const signature = Buffer.from(signatureB64, 'base64');

    // Verificar la firma con la llave pública (ECDSA P-256 + SHA256)
    const verifier = createVerify('sha256');
    verifier.update(recanonical, 'utf-8');

    if (verifier.verify(publicKeyPem, signature)) {
      return 'verified';
    } else {
      console.warn('[verify] Signature verification failed');
      return 'unverified';
    }
  } catch (error) {
    console.warn('[verify] Exception during verification:', error);
    return 'unverified';
  }
}
