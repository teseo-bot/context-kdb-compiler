// KL0-W2 — Validador OKF de 3 niveles, DETERMINISTA Y PURO ([INV-KL1], [INV-KL5]).
//
// Cero I/O: no importa `pg`, `@google-cloud/storage`, `bundle-store`, `storage-adapter` ni
// `server.ts`. Lo verifica un test dedicado (validator.test.ts, "[INV-KL5]"). Esta misma
// librería es usada por el editor (vía panel → /internal/partner-validate) y por el gate del
// publisher (cuando exista, PA2-W4) — [INV-KL1]: no duplicar reglas en dos sitios.
//
// Fuente normativa:
//   N1 — docs/referencias/OKF-SPEC-v0.1-Google.md §4/§6/§7/§9 (frontmatter parseable, `type`
//        no vacío, estructura de index.md/log.md).
//   N2 — ConceptFrontmatterSchema (perfil Teseo), espejo local en
//        src/infrastructure/concept-frontmatter.schema.ts (K-series).
//   N3 — PartnerConceptFrontmatterSchema (extensión partner), espejo local en
//        src/partners/partners-mirror.schema.ts (PA0-W1).
// Diseño: docs/aliados/knowledge-lab/DISEÑO-Knowledge-Lab.md §2 y §5 (INV-KL1/2/5).
// Plan: docs/aliados/knowledge-lab/PLAN-KnowledgeLab-Epicas-KL.md (KL0-W2).
//
// ValidationFinding/ValidationReport son un espejo de contracts/src/okf-lint.ts (KL0-W1) —
// mismo shape, sin importar `contracts` (no es dependencia npm de este repo, mismo motivo que
// el resto de los espejos locales). `fix.value`/`fix.from`/`fix.to` son campos INTERNOS de este
// compiler (no existen en ValidationFindingSchema de contracts): el Zod schema remoto de `fix`
// no usa `.strict()`, así que tolera y descarta claves extra al serializar/parsear en el otro
// extremo — es seguro llevarlos aquí para que `applyQuickFix` no tenga que recalcular nada.

import matter from 'gray-matter';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import {
  ConceptFrontmatterSchema,
  SourceRefSchema,
  HOCFLIT_SYSTEMS,
} from '../infrastructure/concept-frontmatter.schema';
import { PartnerConceptFrontmatterSchema } from './partners-mirror.schema';

// Espejo de FRONTMATTER_YAML_ENGINE (src/infrastructure/bundle-store.ts, K3-W2) — DUPLICADO
// aquí en vez de importado, porque bundle-store.ts también importa `@google-cloud/storage`
// (I/O real) y arrastrarlo rompería la pureza de este módulo ([INV-KL5]). Motivo del engine:
// el schema YAML por defecto de js-yaml autodetecta scalars sin comillas con forma
// `2026-07-01T10:00:00Z` como tipo `!!timestamp` y los convierte a `Date`, lo que rompe
// `ConceptFrontmatterSchema.timestamp` (`z.string().datetime()`, espera un string). JSON_SCHEMA
// preserva esos valores como string.
const FRONTMATTER_YAML_ENGINE = {
  parse: (input: string) => yaml.load(input, { schema: yaml.JSON_SCHEMA }),
  stringify: (data: object) => yaml.dump(data, { schema: yaml.JSON_SCHEMA }),
};

function parseMatter(markdown: string) {
  return matter(markdown, { engines: { yaml: FRONTMATTER_YAML_ENGINE } });
}

function stringifyMatter(content: string, data: Record<string, any>): string {
  return matter.stringify(content, data, { engines: { yaml: FRONTMATTER_YAML_ENGINE } } as any);
}

// GATE DE PUBLICACIÓN (INV-KL2, RP-KL2): partner-publish (PA2-W4) DEBE llamar
// validatePackage(files, {level:'n3', forPublish:true}) y abortar con 422 + findings si ∃
// error. src/partners/publisher.ts NO EXISTE AÚN (PA2-W4 pendiente) — no se crea aquí
// (KL0-W3: "si PA2-W4 no está construido, no improvisar el publisher").

export type LintLevel = 'n1' | 'n2' | 'n3';
export type LintSeverity = 'error' | 'warn';

export interface ValidationFix {
  kind: 'set_field' | 'replace_text';
  description_es: string;
  /** interno: ver nota de cabecera — no forma parte del contrato remoto */
  value?: string;
  /** interno, solo replace_text: texto original a reemplazar */
  from?: string;
  /** interno, solo replace_text: texto de reemplazo */
  to?: string;
}

export interface ValidationFinding {
  rule_id: string;
  level: LintLevel;
  severity: LintSeverity;
  message_es: string;
  line?: number;
  fix?: ValidationFix;
}

export interface ValidationReport {
  path: string;
  findings: ValidationFinding[];
  valid: boolean;
}

export interface ValidateConceptOptions {
  level: 'n2' | 'n3';
  packagePaths?: string[];
  forPublish?: boolean;
  filename?: string;
}

const HOCFLIT_SYSTEM_LIST = HOCFLIT_SYSTEMS as readonly string[];

const FIELD_MESSAGES: Record<string, string> = {
  type: 'type debe ser uno de los 7 tipos de concepto: Insight, Perfil, Politica, Proceso, Metrica, Riesgo, Fuente.',
  title: 'title es obligatorio y debe medir entre 1 y 120 caracteres.',
  description: 'description es obligatoria y debe medir entre 1 y 240 caracteres.',
  tags: 'tags debe ser una lista con al menos un elemento.',
  sources: 'sources debe incluir al menos una fuente registrada.',
  confidence: 'confidence debe ser uno de: "draft", "reviewed" o "consolidated".',
  pii: 'pii debe ser "clean" o "redacted".',
  altitude: 'altitude debe ser un número entero entre 1 y 5.',
  resource: 'resource debe ser una URL válida.',
};

const MD_LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;
const MD_TARGET_REGEX = /\.md(#.*)?$/;
const HOCFLIT_PATH_PREFIX_REGEX = new RegExp(`^/(${HOCFLIT_SYSTEM_LIST.join('|')})/`);

// --- N1: frontmatter ---------------------------------------------------------------------

function parseFrontmatterOrNull(markdown: string): { data: Record<string, any>; content: string } | null {
  const withoutBom = markdown.replace(/^﻿/, '');
  if (!/^---\r?\n/.test(withoutBom)) return null; // no hay bloque `---` inicial
  try {
    const parsed = parseMatter(withoutBom);
    return { data: parsed.data ?? {}, content: parsed.content ?? '' };
  } catch {
    return null; // gray-matter lanzó (YAML inválido)
  }
}

// --- N2: reglas dedicadas (no parte del mapeo genérico de issues Zod) --------------------

function isIsoDatetime(value: string): boolean {
  return z.string().datetime().safeParse(value).success;
}

function checkTimestamp(data: Record<string, any>): ValidationFinding | null {
  const raw = data?.timestamp;
  if (typeof raw === 'string' && isIsoDatetime(raw)) return null;

  const parsedMs = typeof raw === 'string' ? Date.parse(raw) : NaN;
  const fix: ValidationFix | undefined = Number.isNaN(parsedMs)
    ? undefined
    : {
        kind: 'set_field',
        description_es: `Normalizar timestamp a ISO 8601 ("${new Date(parsedMs).toISOString()}").`,
        value: new Date(parsedMs).toISOString(),
      };

  return {
    rule_id: 'n2-timestamp',
    level: 'n2',
    severity: 'error',
    message_es:
      raw === undefined || raw === null || raw === ''
        ? 'timestamp es obligatorio y debe ser una fecha y hora en formato ISO 8601 (ej. 2026-07-08T10:00:00Z).'
        : 'timestamp debe ser una fecha y hora en formato ISO 8601 (ej. 2026-07-08T10:00:00Z).',
    fix,
  };
}

function titleFromFilename(filePath: string): string {
  const base = (filePath.split('/').pop() ?? filePath).replace(/\.md$/i, '');
  const words = base.split(/[-_]+/).filter(Boolean);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function checkTitle(data: Record<string, any>, filename?: string): ValidationFinding | null {
  const raw = data?.title;
  const missing = typeof raw !== 'string' || raw.trim() === '';
  const tooLong = typeof raw === 'string' && raw.length > 120;
  if (!missing && !tooLong) return null;

  const fix: ValidationFix | undefined =
    missing && filename
      ? {
          kind: 'set_field',
          description_es: `Generar title desde el nombre de archivo ("${titleFromFilename(filename)}").`,
          value: titleFromFilename(filename),
        }
      : undefined;

  return {
    rule_id: 'n2-title',
    level: 'n2',
    severity: 'error',
    message_es: FIELD_MESSAGES.title,
    fix,
  };
}

function checkTagsSistema(data: Record<string, any>): ValidationFinding | null {
  if (!Array.isArray(data?.tags) || data.tags.length === 0) return null; // cubierto por el mapeo genérico (n2-tags)

  const first = data.tags[0];
  if (typeof first === 'string' && HOCFLIT_SYSTEM_LIST.includes(first)) return null; // ok

  const idx = data.tags.findIndex((t: unknown) => typeof t === 'string' && HOCFLIT_SYSTEM_LIST.includes(t));
  if (idx > 0) {
    const system = data.tags[idx];
    return {
      rule_id: 'n2-tags-sistema',
      level: 'n2',
      severity: 'error',
      message_es: `tags[0] debe ser el sistema HOCFLIT; se encontró "${system}" en la posición ${idx} de tags.`,
      fix: {
        kind: 'set_field',
        description_es: `Mover "${system}" a tags[0].`,
        value: system,
      },
    };
  }

  return {
    rule_id: 'n2-tags-sistema',
    level: 'n2',
    severity: 'error',
    message_es: `tags[0] debe ser un sistema HOCFLIT (${HOCFLIT_SYSTEM_LIST.join(', ')}); ninguno de los tags actuales lo es.`,
  };
}

function checkSourceRefs(data: Record<string, any>): ValidationFinding[] {
  if (!Array.isArray(data?.sources)) return [];
  const findings: ValidationFinding[] = [];
  data.sources.forEach((s: unknown, i: number) => {
    const ok = typeof s === 'string' && SourceRefSchema.safeParse(s).success;
    if (!ok) {
      findings.push({
        rule_id: 'n2-source-ref',
        level: 'n2',
        severity: 'error',
        message_es: `sources[${i}] = "${String(s)}" no tiene un formato válido de source-ref (conv:…, doc:sha256:…, db:…, url:https?://…).`,
      });
    }
  });
  return findings;
}

function checkBodyLength(body: string): ValidationFinding[] {
  const len = body.length;
  if (len > 8000) {
    return [{
      rule_id: 'n2-body-excede',
      level: 'n2',
      severity: 'error',
      message_es: `El cuerpo tiene ${len} caracteres; el máximo permitido es 8000 (~1 página). Divide el concepto.`,
    }];
  }
  if (len > 6000) {
    return [{
      rule_id: 'n2-body-largo',
      level: 'n2',
      severity: 'warn',
      message_es: `El cuerpo tiene ${len} caracteres; se recomienda no superar 6000 (~1 página).`,
    }];
  }
  return [];
}

function isRelativeMdLink(target: string): boolean {
  if (/^https?:\/\//i.test(target)) return false;
  if (target.startsWith('/')) return false;
  if (target.startsWith('@')) return false; // forma partner-path, la evalúa N3
  if (target.startsWith('#')) return false; // ancla pura
  return MD_TARGET_REGEX.test(target);
}

function bundleRelativeForm(target: string): string {
  const stripped = target.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  return `/${stripped}`;
}

function checkRelativeLinks(body: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MD_LINK_REGEX)) {
    const target = match[2].trim();
    if (!isRelativeMdLink(target) || seen.has(target)) continue;
    seen.add(target);
    const to = bundleRelativeForm(target);
    findings.push({
      rule_id: 'n2-link-relativo',
      level: 'n2',
      severity: 'warn',
      message_es: `El link "${target}" usa forma relativa; se recomienda la forma bundle-relativa "${to}" (spec §5.1).`,
      fix: {
        kind: 'replace_text',
        description_es: `Convertir "${target}" a "${to}".`,
        from: target,
        to,
      },
    });
  }
  return findings;
}

// --- N3: reglas dedicadas -----------------------------------------------------------------

function checkCurator(data: Record<string, any>): ValidationFinding[] {
  const result = PartnerConceptFrontmatterSchema.shape.curator.safeParse(data?.curator);
  if (result.success) return [];
  return [{
    rule_id: 'n3-curator',
    level: 'n3',
    severity: 'error',
    message_es: 'curator debe incluir legal_name (3-160 caracteres) y responsible (3-120 caracteres) completos.',
  }];
}

function checkConfidenceForPublish(data: Record<string, any>, forPublish: boolean): ValidationFinding | null {
  if (!forPublish) return null;
  if (data?.confidence === 'reviewed' || data?.confidence === 'consolidated') return null;
  return {
    rule_id: 'n3-confidence-draft',
    level: 'n3',
    severity: 'error',
    message_es: 'Para publicar, confidence debe ser "reviewed" o "consolidated"; "draft" solo es válido en staging (sin forPublish).',
  };
}

function checkCrossLinks(body: string, packagePaths: string[]): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const pathSet = new Set(packagePaths);

  for (const match of body.matchAll(MD_LINK_REGEX)) {
    const target = match[2].trim();
    if (/^https?:\/\//i.test(target)) continue; // URLs permitidas siempre
    const bare = target.split('#')[0];
    if (!MD_TARGET_REGEX.test(target)) continue; // solo cross-links a conceptos .md

    if (/^@[a-z0-9][a-z0-9-]*\//.test(bare)) {
      findings.push({
        rule_id: 'n3-link-externo',
        level: 'n3',
        severity: 'error',
        message_es: `El link "${target}" apunta a otro aliado/paquete (prefijo @slug/); los cross-links deben ser intra-paquete (INV-2.4).`,
      });
      continue;
    }

    if (bare.includes('../')) {
      findings.push({
        rule_id: 'n3-link-externo',
        level: 'n3',
        severity: 'error',
        message_es: `El link "${target}" usa "../" y escapa del paquete; los cross-links deben ser intra-paquete (INV-2.4).`,
      });
      continue;
    }

    if (HOCFLIT_PATH_PREFIX_REGEX.test(bare)) {
      if (!pathSet.has(bare)) {
        findings.push({
          rule_id: 'n3-link-externo',
          level: 'n3',
          severity: 'error',
          message_es: `El link "${target}" apunta a un path de sistema del tenant que no pertenece a este paquete.`,
        });
      }
      continue;
    }

    const normalized = bare.startsWith('/') ? bare : bundleRelativeForm(bare);
    if (!pathSet.has(normalized)) {
      findings.push({
        rule_id: 'n3-link-pendiente',
        level: 'n3',
        severity: 'warn',
        message_es: `El link "${target}" aún no existe en el paquete (destino pendiente); la spec OKF tolera links rotos (§5.3).`,
      });
    }
  }

  return findings;
}

// --- API pública ----------------------------------------------------------------------------

export function validateConcept(markdown: string, opts: ValidateConceptOptions): ValidationReport {
  const path = opts.filename ?? '';
  const findings: ValidationFinding[] = [];

  const parsed = parseFrontmatterOrNull(markdown);
  if (!parsed) {
    findings.push({
      rule_id: 'n1-frontmatter-invalido',
      level: 'n1',
      severity: 'error',
      message_es: 'El archivo no tiene un bloque de frontmatter YAML parseable, delimitado por "---" (spec OKF §4, §9).',
    });
    return { path, findings, valid: false };
  }

  const { data, content: body } = parsed;

  // N1 --------------------------------------------------------------------------------------
  if (typeof data.type !== 'string' || data.type.trim() === '') {
    findings.push({
      rule_id: 'n1-type-requerido',
      level: 'n1',
      severity: 'error',
      message_es: 'El frontmatter debe declarar "type" con un valor no vacío (spec OKF §4.1, §9).',
    });
  }

  // N2 --------------------------------------------------------------------------------------
  const n2Result = ConceptFrontmatterSchema.safeParse(data);
  if (!n2Result.success) {
    const seenFields = new Set<string>();
    for (const issue of n2Result.error.issues) {
      const field = String(issue.path[0] ?? '');
      if (field === 'tags' && issue.code === 'custom') continue; // manejado por n2-tags-sistema
      if (field === 'sources' && issue.path.length > 1) continue; // manejado por n2-source-ref (por índice)
      if (field === 'timestamp') continue; // manejado por checkTimestamp (con fix)
      if (field === 'title') continue; // manejado por checkTitle (con fix desde filename)
      const ruleId = `n2-${field.replace(/_/g, '-')}`;
      if (seenFields.has(ruleId)) continue;
      seenFields.add(ruleId);
      findings.push({
        rule_id: ruleId,
        level: 'n2',
        severity: 'error',
        message_es: FIELD_MESSAGES[field] ?? `El campo "${field}" no cumple el perfil Teseo (ConceptFrontmatterSchema).`,
      });
    }
  }

  const titleFinding = checkTitle(data, opts.filename);
  if (titleFinding) findings.push(titleFinding);

  const timestampFinding = checkTimestamp(data);
  if (timestampFinding) findings.push(timestampFinding);

  const tagsFinding = checkTagsSistema(data);
  if (tagsFinding) findings.push(tagsFinding);

  findings.push(...checkSourceRefs(data));
  findings.push(...checkBodyLength(body));
  findings.push(...checkRelativeLinks(body));

  // N3 --------------------------------------------------------------------------------------
  if (opts.level === 'n3') {
    findings.push(...checkCurator(data));
    const confidenceFinding = checkConfidenceForPublish(data, opts.forPublish ?? false);
    if (confidenceFinding) findings.push(confidenceFinding);
    findings.push(...checkCrossLinks(body, opts.packagePaths ?? []));
  }

  const valid = !findings.some(f => f.severity === 'error');
  return { path, findings, valid };
}

function isReservedFilename(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? filePath;
  return base === 'index.md' || base === 'log.md';
}

function normalizePackagePath(filePath: string): string {
  return filePath.startsWith('/') ? filePath : `/${filePath}`;
}

function validateReservedFile(filePath: string, markdown: string): ValidationReport {
  const findings: ValidationFinding[] = [];
  const base = filePath.split('/').pop() ?? filePath;
  const isRoot = !filePath.replace(/^\//, '').includes('/'); // 'index.md' exacto, sin subdirectorio

  if (base === 'index.md') {
    const hasFrontmatter = /^---\r?\n/.test(markdown);
    let body = markdown;
    if (hasFrontmatter) {
      const parsedMatter = parseMatter(markdown);
      body = parsedMatter.content ?? '';
      if (!isRoot) {
        findings.push({
          rule_id: 'n1-index-estructura',
          level: 'n1',
          severity: 'warn',
          message_es: `"${filePath}" no es la raíz del paquete y no debería llevar frontmatter (spec §6/§11: solo el index.md raíz puede declarar okf_version).`,
        });
      } else {
        const keys = Object.keys(parsedMatter.data ?? {});
        if (keys.some(k => k !== 'okf_version')) {
          findings.push({
            rule_id: 'n1-index-estructura',
            level: 'n1',
            severity: 'warn',
            message_es: 'El index.md raíz solo puede declarar "okf_version" en su frontmatter (spec §11).',
          });
        }
      }
    }
    if (!/^[*-]\s*\[.+\]\(.+\)/m.test(body)) {
      findings.push({
        rule_id: 'n1-index-estructura',
        level: 'n1',
        severity: 'warn',
        message_es: `"${filePath}" no tiene la estructura de lista con enlaces esperada para un index.md (spec §6).`,
      });
    }
  } else if (base === 'log.md') {
    const headingLines = markdown.split('\n').map(l => l.trim()).filter(l => /^##\s+/.test(l));
    const hasBadHeading = headingLines.some(l => !/^##\s+\d{4}-\d{2}-\d{2}\s*$/.test(l));
    if (headingLines.length === 0 || hasBadHeading) {
      findings.push({
        rule_id: 'n1-log-fechas',
        level: 'n1',
        severity: 'warn',
        message_es: `"${filePath}" debe usar encabezados de fecha "## YYYY-MM-DD" (spec §7).`,
      });
    }
  }

  const valid = !findings.some(f => f.severity === 'error');
  return { path: filePath, findings, valid };
}

export interface ValidatePackageOptions {
  level: 'n2' | 'n3';
  packagePaths?: string[];
  forPublish?: boolean;
}

export function validatePackage(
  files: { path: string; markdown: string }[],
  opts: ValidatePackageOptions
): ValidationReport[] {
  const conceptPaths = files
    .filter(f => !isReservedFilename(f.path))
    .map(f => normalizePackagePath(f.path));
  const packagePaths = Array.from(new Set([...(opts.packagePaths ?? []), ...conceptPaths]));

  return files.map(file => {
    if (isReservedFilename(file.path)) {
      return validateReservedFile(file.path, file.markdown);
    }
    return validateConcept(file.markdown, {
      level: opts.level,
      packagePaths,
      forPublish: opts.forPublish,
      filename: file.path,
    });
  });
}

// --- applyQuickFix ---------------------------------------------------------------------------

function fixTitleFromFilename(markdown: string, finding: ValidationFinding): string {
  if (!finding.fix?.value) return markdown;
  const parsed = parseFrontmatterOrNull(markdown);
  if (!parsed) return markdown;
  if (typeof parsed.data.title === 'string' && parsed.data.title.trim() !== '') return markdown; // idempotente
  return stringifyMatter(parsed.content, { ...parsed.data, title: finding.fix.value });
}

function fixTagsSistema(markdown: string, finding: ValidationFinding): string {
  if (!finding.fix?.value) return markdown;
  const parsed = parseFrontmatterOrNull(markdown);
  if (!parsed) return markdown;
  const tags = Array.isArray(parsed.data.tags) ? [...parsed.data.tags] : [];
  if (tags[0] === finding.fix.value) return markdown; // idempotente
  const idx = tags.indexOf(finding.fix.value);
  if (idx === -1) return markdown;
  tags.splice(idx, 1);
  tags.unshift(finding.fix.value);
  return stringifyMatter(parsed.content, { ...parsed.data, tags });
}

function fixTimestamp(markdown: string, finding: ValidationFinding): string {
  if (!finding.fix?.value) return markdown;
  const parsed = parseFrontmatterOrNull(markdown);
  if (!parsed) return markdown;
  if (parsed.data.timestamp === finding.fix.value) return markdown; // idempotente
  return stringifyMatter(parsed.content, { ...parsed.data, timestamp: finding.fix.value });
}

function fixRelativeLink(markdown: string, finding: ValidationFinding): string {
  if (finding.fix?.from === undefined || finding.fix?.to === undefined) return markdown;
  const pattern = `](${finding.fix.from})`;
  const replacement = `](${finding.fix.to})`;
  if (!markdown.includes(pattern)) return markdown; // idempotente / ya aplicado
  return markdown.replace(pattern, replacement);
}

/**
 * Aplica una reparación determinista de `finding.fix` sobre `markdown`. Solo conoce las 4
 * reparaciones deterministas del diseño (título desde filename, sistema→tags[0], timestamp a
 * ISO 8601, link relativo→bundle-relativo); cualquier otro rule_id devuelve `markdown` intacto.
 * Cada función interna es idempotente por construcción (verifica la precondición antes de
 * mutar), así que aplicar dos veces produce el mismo resultado que aplicar una vez.
 */
export function applyQuickFix(markdown: string, finding: ValidationFinding): string {
  if (!finding.fix) return markdown;
  switch (finding.rule_id) {
    case 'n2-title':
      return fixTitleFromFilename(markdown, finding);
    case 'n2-tags-sistema':
      return fixTagsSistema(markdown, finding);
    case 'n2-timestamp':
      return fixTimestamp(markdown, finding);
    case 'n2-link-relativo':
      return fixRelativeLink(markdown, finding);
    default:
      return markdown;
  }
}
