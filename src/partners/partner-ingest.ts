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
  document: {
    filename: string;
    content_base64?: string;
    text?: string;
  };
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
  // Decodificar contenido
  const rawContent = decodeDocumentContent(input.document);

  // Paso 1: Distiller (V2) — transforma a un concepto OKF
  const candidate: DistillCandidateInput = {
    kind: 'api',
    source_ref: `partner-ingest:${input.partner_id}/${input.package_slug}/${input.document.filename}`,
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
