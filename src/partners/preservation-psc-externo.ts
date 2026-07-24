/**
 * NOM-151 — Adaptador de conservación por PSC EXTERNO (`psc-externo`) — STUB por contratar.
 *
 * Emite (cuando esté contratado) una constancia NOM-151 ACREDITADA: se envía el hash/mensaje a un
 * PSC autorizado por la Secretaría de Economía (candidatos D-P3: Mifiel / WeeTrust / Trato), que
 * devuelve un sello de tiempo RFC-3161 / constancia PKCS#7 con valor probatorio pleno
 * (`legal_grade: 'psc-accredited'`).
 *
 * Estado: STUB. El PSC aún NO está elegido/contratado (D-P3 abierto). Este adaptador fija la FORMA
 * de la integración para que contratarlo sea "inyectar `submit`/`verifyToken` + endpoint", sin
 * re-arquitectura ni cambios en los llamadores.
 *
 * ⚠️ FAIL-CLOSED (invariante de compliance): sin PSC configurado, `preserve` LANZA
 * `PscNotConfiguredError`. JAMÁS fabrica una constancia acreditada falsa — una constancia
 * `psc-accredited` inválida sería peor que ninguna (perjurio probatorio). No hay ruta silenciosa.
 */

import {
  SignAndPreserve,
  PreservationSubject,
  Constancia,
  PreservationVerification,
  PscNotConfiguredError,
} from './preservation';

/** Petición al PSC. `message_b64` opcional: algunos PSC sellan el hash, otros el documento. */
export interface PscSubmitRequest {
  message_sha256: string;
  subject_ref: string;
  message_b64?: string;
}

/** Respuesta del PSC: el token/constancia acreditada + su metadata. */
export interface PscSubmitResponse {
  /** Sello de tiempo ISO-8601 UTC emitido por la TSA del PSC (la fecha cierta acreditada). */
  timestamp: string;
  /** Token de la constancia (RFC-3161 / PKCS#7), base64. */
  token_b64: string;
  /** Tipo de prueba: 'rfc3161' | 'pkcs7'. */
  proof_type: string;
  /** Emisor: PSC + nº de acreditación ante la SE. */
  issuer: string;
  /** Metadata opcional (nº de serie, OID de política de sellado, etc.). */
  meta?: Record<string, unknown>;
}

export interface PscExternoDeps {
  /** Endpoint del PSC. Default: `NOM151_PSC_ENDPOINT`. Sin esto ni `submit` ⇒ fail-closed. */
  endpoint?: string;
  /** Referencia/valor de la credencial del PSC (secreto). Default: `NOM151_PSC_API_KEY`. */
  apiKey?: string;
  /** Nombre del PSC ('mifiel' | 'weetrust' | 'trato'). Default: `NOM151_PSC_PROVIDER`. */
  providerName?: string;
  /**
   * Cliente de envío al PSC. Es el punto de inyección de la integración real (HTTP) y de los
   * tests. Ausente + sin endpoint ⇒ `preserve` lanza `PscNotConfiguredError`.
   */
  submit?: (req: PscSubmitRequest) => Promise<PscSubmitResponse>;
  /** Verificación RFC-3161/PKCS#7 del token contra el certificado del PSC. Inyectable. */
  verifyToken?: (constancia: Constancia) => Promise<boolean>;
}

export class PscExternoPreserver implements SignAndPreserve {
  readonly provider = 'psc-externo' as const;
  readonly legalGrade = 'psc-accredited' as const;

  private readonly deps: PscExternoDeps;

  constructor(deps: PscExternoDeps = {}) {
    this.deps = deps;
  }

  private submitFn(): (req: PscSubmitRequest) => Promise<PscSubmitResponse> {
    if (this.deps.submit) return this.deps.submit;

    const endpoint = this.deps.endpoint ?? process.env.NOM151_PSC_ENDPOINT;
    if (!endpoint) {
      // Fail-closed: sin PSC contratado no hay constancia acreditada. Nunca se finge.
      throw new PscNotConfiguredError();
    }
    // PSC contratado pero sin adaptador de submit implementado todavía: aún fail-closed, con un
    // mensaje que apunta a la WU de integración real (no una ruta silenciosa que "casi funciona").
    throw new PscNotConfiguredError(
      `PSC '${this.deps.providerName ?? process.env.NOM151_PSC_PROVIDER ?? 'desconocido'}' con ` +
        `endpoint configurado (${endpoint}) pero sin cliente de submit implementado. Falta la WU ` +
        `de integración del PSC (inyectar deps.submit con el cliente HTTP real).`
    );
  }

  async preserve(subject: PreservationSubject): Promise<Constancia> {
    const submit = this.submitFn(); // lanza PscNotConfiguredError si no hay PSC real

    const resp = await submit({
      message_sha256: subject.message_sha256,
      subject_ref: subject.ref,
      message_b64: subject.message ? subject.message.toString('base64') : undefined,
    });

    return {
      constancia_version: '1',
      message_sha256: subject.message_sha256,
      subject_ref: subject.ref,
      timestamp: resp.timestamp,
      timestamp_source: 'psc-tsa',
      provider: this.provider,
      legal_grade: this.legalGrade,
      proof: { type: resp.proof_type, value_b64: resp.token_b64, meta: resp.meta },
      issuer: resp.issuer,
    };
  }

  async verify(constancia: Constancia): Promise<PreservationVerification> {
    if (constancia.provider !== this.provider) {
      return {
        status: 'unsupported',
        reason: `Constancia de proveedor '${constancia.provider}', no verificable por psc-externo.`,
      };
    }
    if (!this.deps.verifyToken) {
      // La verificación RFC-3161/PKCS#7 requiere el certificado del PSC (pendiente D-P3).
      return {
        status: 'unsupported',
        reason:
          'Verificación de constancia PSC (RFC-3161/PKCS#7) no implementada: requiere el ' +
          'certificado del PSC contratado (D-P3 pendiente). Inyecta deps.verifyToken.',
      };
    }
    try {
      const ok = await this.deps.verifyToken(constancia);
      return ok
        ? { status: 'verified' }
        : { status: 'unverified', reason: 'El token del PSC no verifica.' };
    } catch (error) {
      return {
        status: 'unverified',
        reason: `Excepción durante la verificación del PSC: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
