/**
 * PA2-W3: Ingesta modo partner
 *
 * Orquesta el pipeline V2 (distiller-v2 + hocflit-router + pii-redactor) para
 * documentos ingresados vía ruta /internal/partner-ingest.
 *
 * Pipeline:
 *  1. distillCandidate (distiller-v2) → draft con confidence:'draft'
 *  2. buildTargetPath + clasificación HOCFLIT
 *  3. redactPii (pii-redactor) → marca draft.pii
 *  4. valida contra PartnerConceptFrontmatterSchema (excepto confidence que sigue draft)
 *  5. escribe a _staging/{fecha}/ del bundle del aliado
 *
 * KL2-W2: además de `document` (contenido inline), acepta `source_gcs_object` — el path de un
 * documento YA subido a `_fuentes/` del bundle del aliado vía `/internal/partner-source-upload`
 * (KL2-W1, `src/partners/source-upload.ts`). Cuando llega `source_gcs_object`, este módulo lee
 * el objeto server-side (misma `store`, mismo bundle) en vez de requerir que el panel reenvíe
 * el binario completo. El objeto en `_fuentes/` se escribió con el contenido base64 TAL CUAL
 * (ver comentario de codificación en `source-upload.ts`), así que se rehidrata como
 * `document.content_base64` y reusa el decodificador existente sin cambios.
 */

import { z } from 'zod';
import * as yaml from 'js-yaml';
import { BundleStore } from '../infrastructure/bundle-store';
import { distillCandidate, DistillerLlm, DistillCandidateInput } from '../ingestion/distiller-v2';
import { buildTargetPath } from '../ingestion/hocflit-router';
import { redactPii, PiiLlm } from '../ingestion/pii-redactor';
import { HocflitHint } from '../schemas/contracts';
import { PartnerConceptFrontmatterSchema } from './partners-mirror.schema';
import { ConceptFrontmatterSchema } from '../infrastructure/concept-frontmatter.schema';

export interface PartnerIngestInput {
  partner_id: string;
  package_slug: string;
  /** Contenido inline. Mutuamente excluyente con `source_gcs_object` (uno de los dos es
   * requerido; la validación de "al menos uno" vive en la ruta de server.ts). */
  document?: {
    filename: string;
    content_base64?: string;
    text?: string;
  };
  /** KL2-W2: path de un documento ya subido a `_fuentes/` del bundle del aliado (devuelto por
   * `/internal/partner-source-upload`, KL2-W1). Si se provee, se ignora `document` y se lee el
   * objeto server-side. */
  source_gcs_object?: string;
}

export interface DraftOutput {
  path: string;
  title: string;
  system: string;
  altitude: number;
  pii: 'clean' | 'redacted';
}

export interface PartnerIngestResult {
  drafts: DraftOutput[];
}

/**
 * Decodifica content_base64 o text del documento
 */
function decodeDocumentContent(doc: { content_base64?: string; text?: string }): string {
  if (doc.content_base64) {
    return Buffer.from(doc.content_base64, 'base64').toString('utf8');
  }
  if (doc.text) {
    return doc.text;
  }
  throw new Error('Document must have content_base64 or text');
}

function basenameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * KL2-W2: resuelve el `document` efectivo a partir de `input.document` o, si viene
 * `source_gcs_object`, leyendo el objeto de `_fuentes/` server-side. El objeto se escribió
 * (KL2-W1) con el contenido base64 sin decodificar, así que se rehidrata tal cual como
 * `content_base64`.
 */
async function resolveDocument(
  input: PartnerIngestInput,
  store: BundleStore
): Promise<{ filename: string; content_base64?: string; text?: string }> {
  if (input.source_gcs_object) {
    const stored = await store.read(input.source_gcs_object);
    if (!stored) {
      throw new Error(`source_gcs_object no encontrado en el bundle: ${input.source_gcs_object}`);
    }
    return { filename: basenameOf(input.source_gcs_object), content_base64: stored.content };
  }
  if (input.document) {
    return input.document;
  }
  throw new Error('PartnerIngestInput debe traer document o source_gcs_object');
}

/**
 * Orquesta el pipeline V2 para ingesta modo partner
 *
 * Reusa:
 * - distillCandidate (distiller-v2): emite draft con title, description, body, frontmatter
 * - buildTargetPath (hocflit-router): genera path desde tags[0] + slug de título
 * - redactPii (pii-redactor): detecta y redacta PII en title/description/body
 */
export async function ingestPartnerDocument(
  input: PartnerIngestInput,
  store: BundleStore,
  opts?: {
    distillerLlm?: DistillerLlm;
    piiLlm?: PiiLlm;
  }
): Promise<PartnerIngestResult> {
  // KL2-W2: resuelve document inline o desde `_fuentes/` (source_gcs_object)
  const document = await resolveDocument(input, store);

  // Decodificar contenido
  const rawContent = decodeDocumentContent(document);

  // Paso 1: Distiller (V2) — transforma a un concepto OKF
  const candidate: DistillCandidateInput = {
    kind: 'api',
    source_ref: `partner-ingest:${input.partner_id}/${input.package_slug}/${document.filename}`,
    payload_summary: rawContent.slice(0, 500),
  };

  const hint: HocflitHint = {
    source_module: 'api',
    system: 'l-legal', // default; el distiller lo puede cambiar si hay evidencia
    tags: [],
  };

  const draft = await distillCandidate(candidate, rawContent, opts?.distillerLlm, hint);

  // Paso 2: Router HOCFLIT — construir target path
  // Garantizar que tags existe (distiller-v2 siempre lo produce)
  if (!draft.frontmatter.tags || draft.frontmatter.tags.length === 0) {
    throw new Error('Draft frontmatter missing tags (distiller-v2 should provide this)');
  }
  const targetPath = buildTargetPath(
    { tags: draft.frontmatter.tags },
    draft.frontmatter.title
  );
  const [system, slugWithExt] = targetPath.split('/');

  // Paso 3: Redacción de PII
  const redacted = await redactPii(
    {
      title: draft.frontmatter.title,
      description: draft.frontmatter.description,
      body: draft.body,
    },
    opts?.piiLlm
  );

  // Paso 4: Frontmatter completo para partner (con curator placeholder si falta)
  // INV-2.1: pii debe ser clean|redacted, nunca raw
  // INV-2.3: curator DEBE venir incompleto en draft de ingesta (lo completa el curator luego)
  const frontmatter = {
    ...draft.frontmatter,
    title: redacted.title,
    description: redacted.description,
    confidence: 'draft' as const, // Siempre draft en ingesta
    pii: redacted.pii,
    // curator: no se incluye aún — se lo proporciona el curator en partner-draft-update
  };

  // Validación parcial: verificar que el frontmatter básico sea válido contra schema base
  // (ConceptFrontmatterSchema permite confidence:'draft'). El curator se valida después en
  // partner-draft-update cuando esté completo.
  const baseValidation = ConceptFrontmatterSchema.safeParse(frontmatter);
  if (!baseValidation.success) {
    throw new Error(`Draft frontmatter inválido: ${JSON.stringify(baseValidation.error.issues)}`);
  }

  // Paso 5: Escribir draft a _staging/{fecha}/{slug}.md
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const draftPath = `_staging/${today}/${slugWithExt}`;
  const frontmatterStr = formatFrontmatter(frontmatter);
  const draftContent = `${frontmatterStr}\n\n${redacted.body}`;

  await store.write(draftPath, draftContent, {
    actor: 'partner-ingest-api',
    accion: 'draft',
  });

  // Devolver metadata del draft creado
  return {
    drafts: [
      {
        path: draftPath,
        title: redacted.title,
        system: system,
        altitude: frontmatter.altitude,
        pii: redacted.pii,
      },
    ],
  };
}

/**
 * Formatea frontmatter YAML usando el esquema JSON_SCHEMA (preserva strings sin conversiones)
 */
function formatFrontmatter(fm: Record<string, unknown>): string {
  // Omitir curator en el frontmatter de ingesta (se añade en draft-update)
  const { curator, ...withoutCurator } = fm as any;

  const yamlStr = yaml.dump(withoutCurator, { schema: yaml.JSON_SCHEMA });
  return `---\n${yamlStr}---`;
}
