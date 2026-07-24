/**
 * NOM-151 — Seam de firma/conservación AGNÓSTICO (`SignAndPreserve`).
 *
 * Marco legal: Código de Comercio arts. 89–97 + NOM-151-SCFI-2016 ("Requisitos que deben
 * observarse para la conservación de mensajes de datos y digitalización de documentos").
 *
 * Capas de evidencia (RFC-ALIADOS §5.2, decisión CEO v1 = A + D):
 *   - Capa A (KMS)  → `src/partners/signer.ts`: firma criptográfica del CONTENIDO (el manifiesto
 *     canónico) con la llave por-aliado. Da integridad + no-repudio TÉCNICO. YA construida.
 *   - Capa D (NOM-151) → ESTE seam: **constancia de conservación** = sello de tiempo sobre el
 *     mensaje de datos (el manifiesto ya firmado). Da FECHA CIERTA + integridad ante terceros.
 *     Es un COMPLEMENTO, no una firma: no re-firma el contenido, lo sella en el tiempo.
 *
 * Por qué agnóstico (D-P3 del RFC, ABIERTO): la elección del PSC (Mifiel / WeeTrust / Trato)
 * está pendiente de análisis costo-beneficio. Este seam construye la interfaz abstracta + dos
 * adaptadores stub (`kms-timestamp` propio, `psc-externo` por contratar) para que la decisión
 * del PSC se difiera SIN re-arquitectar: al contratarlo, solo se cambia el proveedor por config
 * (`resolvePreserver`) — ningún llamador (p.ej. `publisher.ts`) cambia.
 *
 * ⚠️ Honestidad legal: SOLO un PSC acreditado por la Secretaría de Economía emite una constancia
 * NOM-151 con valor probatorio pleno (`legal_grade: 'psc-accredited'`). El adaptador propio
 * `kms-timestamp` emite un registro de conservación TÉCNICO auto-firmado (`legal_grade:
 * 'technical'`): evidencia real y verificable, pero NO equivalente a la constancia del PSC. El
 * campo `legal_grade` nunca miente sobre esto.
 */

/** Proveedores de conservación soportados por el seam. */
export type PreservationProvider = 'kms-timestamp' | 'psc-externo';

/**
 * Grado legal de la constancia:
 *  - 'technical'      → auto-emitida por Teseo (KMS propio). Evidencia pericial, no acreditada.
 *  - 'psc-accredited' → emitida por un PSC acreditado (SE). Constancia NOM-151 con valor pleno.
 */
export type LegalGrade = 'technical' | 'psc-accredited';

/**
 * El "mensaje de datos" (Código de Comercio art. 89) que se conserva. Para el programa de
 * aliados es el manifiesto PCC YA firmado con KMS (capa A).
 */
export interface PreservationSubject {
  /** Referencia legible del sujeto conservado, p.ej. `partner:bufete-demo/package:contratos/v1`. */
  ref: string;
  /** SHA-256 hex del mensaje de datos (== `manifest.manifest_sha256` del manifiesto firmado). */
  message_sha256: string;
  /**
   * Bytes del mensaje de datos. Opcional: algunos PSC sellan solo el hash, otros exigen el doc
   * completo. El adaptador propio `kms-timestamp` sella el hash y no requiere los bytes.
   */
  message?: Buffer;
}

/** Prueba específica del proveedor (firma KMS propia, o token RFC-3161 / PKCS#7 del PSC). */
export interface ConstanciaProof {
  /** Tipo de prueba: 'kms-ecdsa-p256' (propio) | 'rfc3161' | 'pkcs7' (PSC). */
  type: string;
  /** Valor base64 de la prueba (firma / token / constancia del PSC). */
  value_b64: string;
  /** Metadatos opcionales del proveedor (nº de serie, OID de política, hash de la aserción…). */
  meta?: Record<string, unknown>;
}

/**
 * Constancia de Conservación de Mensajes de Datos — forma AGNÓSTICA (no acoplada a ningún PSC).
 * Los campos hasta `provider` forman la ASERCIÓN firmada; `proof`/`legal_grade`/`issuer` son la
 * envoltura verificable. Ver `canonicalizeAssertion`.
 */
export interface Constancia {
  /** Versión del formato (evolución sin romper verificación de constancias viejas). */
  constancia_version: '1';
  /** SHA-256 hex del mensaje de datos conservado (== subject.message_sha256). */
  message_sha256: string;
  /** Referencia del sujeto (partner/paquete/versión). */
  subject_ref: string;
  /** Sello de tiempo ISO-8601 UTC = la FECHA CIERTA. */
  timestamp: string;
  /** Fuente del tiempo: 'kms-server' (reloj propio) | 'psc-tsa' (autoridad de sellado del PSC). */
  timestamp_source: string;
  /** Proveedor emisor. */
  provider: PreservationProvider;
  // --- envoltura (fuera de la aserción firmada) ---
  /** Grado legal — nunca miente sobre la naturaleza de la evidencia. */
  legal_grade: LegalGrade;
  /** Prueba criptográfica de la constancia. */
  proof: ConstanciaProof;
  /** Identidad del emisor (versión de llave KMS propia, o PSC + nº de acreditación). */
  issuer: string;
}

/** Resultado de verificar una constancia. Nunca lanza; reporta estado. */
export interface PreservationVerification {
  status: 'verified' | 'unverified' | 'unsupported';
  reason?: string;
}

/**
 * El seam. Todo proveedor de conservación implementa esta interfaz; los llamadores dependen SOLO
 * de ella, nunca de un adaptador concreto.
 */
export interface SignAndPreserve {
  readonly provider: PreservationProvider;
  readonly legalGrade: LegalGrade;
  /** Emite una Constancia de Conservación sobre el mensaje de datos. */
  preserve(subject: PreservationSubject): Promise<Constancia>;
  /** Verifica una constancia previamente emitida. Nunca lanza. */
  verify(constancia: Constancia): Promise<PreservationVerification>;
}

/** Campos de la constancia que forman la ASERCIÓN firmada (excluye la envoltura). */
export const ASSERTION_FIELDS = [
  'constancia_version',
  'message_sha256',
  'subject_ref',
  'timestamp',
  'timestamp_source',
  'provider',
] as const;

/**
 * Proyecta una constancia (o un objeto de aserción en construcción) a SOLO los campos firmados,
 * para canonicalización estable. Aísla lo que se firma de la envoltura (proof/issuer/legal_grade),
 * evitando depender de la exclusión por-nombre de `canonicalize`.
 */
export function assertionOf(
  c: Pick<Constancia, (typeof ASSERTION_FIELDS)[number]>
): Record<string, unknown> {
  return {
    constancia_version: c.constancia_version,
    message_sha256: c.message_sha256,
    subject_ref: c.subject_ref,
    timestamp: c.timestamp,
    timestamp_source: c.timestamp_source,
    provider: c.provider,
  };
}

/** Se lanza cuando el proveedor PSC no está contratado/configurado (fail-closed). */
export class PscNotConfiguredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'PSC externo no contratado/configurado (D-P3 pendiente): no se emite una constancia ' +
          'NOM-151 acreditada sin un PSC real. Usa el proveedor `kms-timestamp` para evidencia ' +
          'técnica, o configura el PSC (NOM151_PSC_ENDPOINT + adaptador de submit).'
    );
    this.name = 'PscNotConfiguredError';
  }
}

/** Configuración de resolución del proveedor de conservación. */
export interface PreservationConfig {
  /** Proveedor explícito; si se omite, se toma de `NOM151_PROVIDER` (default 'kms-timestamp'). */
  provider?: PreservationProvider;
  /** Deps del adaptador propio. Import perezoso para no acoplar el núcleo a KMS. */
  kms?: import('./preservation-kms-timestamp').KmsTimestampDeps;
  /** Deps del adaptador PSC. */
  psc?: import('./preservation-psc-externo').PscExternoDeps;
}

/**
 * Punto ÚNICO de selección del proveedor — el swap del PSC (D-P3) vive SOLO aquí. Ningún llamador
 * conoce el adaptador concreto; todos dependen de `SignAndPreserve`.
 *
 * Default 'kms-timestamp': sin PSC contratado, el proveedor propio produce evidencia técnica sin
 * fricción; NUNCA finge acreditación (legal_grade: 'technical').
 */
export function resolvePreserver(config: PreservationConfig = {}): SignAndPreserve {
  const provider =
    config.provider ?? (process.env.NOM151_PROVIDER as PreservationProvider | undefined) ?? 'kms-timestamp';

  switch (provider) {
    case 'kms-timestamp': {
      // Import diferido: evita cargar el SDK de KMS cuando se usa el PSC (y viceversa).
      const { KmsTimestampPreserver } = require('./preservation-kms-timestamp');
      return new KmsTimestampPreserver(config.kms ?? {});
    }
    case 'psc-externo': {
      const { PscExternoPreserver } = require('./preservation-psc-externo');
      return new PscExternoPreserver(config.psc ?? {});
    }
    default:
      throw new Error(`Proveedor NOM-151 desconocido: ${String(provider)}`);
  }
}
