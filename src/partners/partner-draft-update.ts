/**
 * PA2-W3: Curaduría de drafts de aliado
 *
 * Valida y reescribe un draft en _staging/:
 *  1. Verifica que draft_path esté bajo _staging/ (path traversal → 422)
 *  2. Valida frontmatter contra PartnerConceptFrontmatterSchema excepto confidence
 *  3. Fuerza confidence a 'draft' hasta publicar
 *  4. Valida que curator esté completo (ambos campos; si falta → 422)
 *  5. Reescribe vía BundleStore (auditado en hash-chain)
 */

import matter from 'gray-matter';
import * as yaml from 'js-yaml';
import { BundleStore, FRONTMATTER_YAML_ENGINE } from '../infrastructure/bundle-store';
import { PartnerConceptFrontmatterSchema } from './partners-mirror.schema';

export interface DraftUpdateInput {
  partner_id: string;
  draft_path: string;
  markdown: string;
}

/**
 * Valida que draft_path esté bajo _staging/ del bundle del aliado
 * Rechaza: "../", rutas absolutas "paquetes/...", etc.
 *
 * KL3-W1: exportado para que `partner-drafts-list.ts` (partner-draft-get) reúse el MISMO guard
 * anti-traversal en vez de duplicarlo (instrucción explícita de la WU).
 */
export function validateDraftPath(draftPath: string): { valid: boolean; reason?: string } {
  if (!draftPath.startsWith('_staging/')) {
    return { valid: false, reason: 'Draft path must be under _staging/ directory' };
  }

  if (draftPath.includes('..')) {
    return { valid: false, reason: 'Path traversal (..) not allowed' };
  }

  if (!draftPath.endsWith('.md')) {
    return { valid: false, reason: 'Draft path must end with .md' };
  }

  return { valid: true };
}

/**
 * Parsea frontmatter de markdown usando el mismo engine que BundleStore
 */
function parseFrontmatterOnly(markdown: string): { data: Record<string, unknown>; content: string } | null {
  const withoutBom = markdown.replace(/^﻿/, '');
  if (!/^---\r?\n/.test(withoutBom)) return null;

  try {
    const parsed = matter(withoutBom, { engines: { yaml: FRONTMATTER_YAML_ENGINE } });
    return { data: parsed.data ?? {}, content: parsed.content ?? '' };
  } catch {
    return null;
  }
}

/**
 * Valida que curator esté completo (ambos legal_name y responsible presentes y válidos)
 */
function validateCuratorComplete(curator: unknown): { valid: boolean; reason?: string } {
  const result = PartnerConceptFrontmatterSchema.shape.curator.safeParse(curator);
  if (!result.success) {
    return {
      valid: false,
      reason: 'Curator must include legal_name (3-160 chars) and responsible (3-120 chars)',
    };
  }
  return { valid: true };
}

/**
 * Actualiza draft de aliado con curaduría
 *
 * Validaciones:
 *  - draft_path bajo _staging/ (422 si no)
 *  - frontmatter contra schema de partner excepto confidence (422 si falla)
 *  - curator completo (422 si no)
 *  - confidence forzado a 'draft'
 *
 * Reescribe vía BundleStore (auditado en log.md con hash-chain).
 */
export async function updatePartnerDraft(
  input: DraftUpdateInput,
  store: BundleStore
): Promise<{ path: string; updated: boolean }> {
  // Validación 1: Path traversal
  const pathValidation = validateDraftPath(input.draft_path);
  if (!pathValidation.valid) {
    throw {
      code: 422,
      message: pathValidation.reason || 'Invalid draft path',
    };
  }

  // Validación 2: Parsear frontmatter
  const parsed = parseFrontmatterOnly(input.markdown);
  if (!parsed) {
    throw {
      code: 422,
      message: 'Invalid markdown: missing or malformed frontmatter block',
    };
  }

  const { data: frontmatter, content: body } = parsed;

  // Validación 3: Curator completo
  const curatorValidation = validateCuratorComplete(frontmatter.curator);
  if (!curatorValidation.valid) {
    throw {
      code: 422,
      message: curatorValidation.reason || 'Curator is incomplete',
    };
  }

  // Validación 4: Frontmatter contra schema (excepto confidence que se fuerza)
  // Usamos omit para permitir que confidence no esté o sea cualquier valor (lo forzamos)
  const frontmatterToValidate = {
    ...frontmatter,
    confidence: 'draft' as const, // Forzar a draft
  };

  // Validar contra el schema del partner (sin usar confidence estricto)
  // Usamos safeParse sobre todos los campos excepto confidence que ya está validado
  const baseSchema = PartnerConceptFrontmatterSchema.omit({ confidence: true });
  const validation = baseSchema.safeParse(frontmatterToValidate);

  if (!validation.success) {
    throw {
      code: 422,
      message: `Invalid frontmatter: ${validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  // Reescribir draft (incluir frontmatter con confidence:'draft' y curator)
  const updatedFrontmatter = {
    ...validation.data,
    confidence: 'draft' as const,
    curator: frontmatter.curator,
  };

  const frontmatterYaml = yaml.dump(updatedFrontmatter, { schema: yaml.JSON_SCHEMA });
  const updatedMarkdown = `---\n${frontmatterYaml}---\n\n${body}`;

  await store.write(input.draft_path, updatedMarkdown, {
    actor: 'partner-draft-update-api',
    accion: 'draft-update',
  });

  return { path: input.draft_path, updated: true };
}
