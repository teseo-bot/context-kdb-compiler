/**
 * PA2-W4: Publisher firmado de paquetes de aliado
 *
 * Orquesta la publicación de una versión de paquete: verifica la cadena del bundle, valida
 * TODOS los drafts aprobados (el publish ES el acto de aprobación: setea confidence:'reviewed'
 * en memoria antes de validar con forPublish:true), escribe los conceptos + portada del
 * paquete, genera y firma el manifest canónico (KMS, PA2-W2), e indexa el delta a
 * okf_partner_concepts/okf_partner_edges en una única transacción SQL ([INV-6.1]).
 *
 * Referencias: TRD-Aliados-Conocimiento-Certificado.md §2 (layout), §5 (índice), §6 (manifest),
 * §7.3 (contrato de la ruta). WORKFLOWS-Aliados.md §3 (INV-3.1..3.5), §6 (INV-6.1).
 * Identidad (partner_id/partner_slug/package_id/package_slug/version) y la selección de
 * draft_paths[] las decide el panel (otra BD, teseo-control) — este módulo NO adivina ninguna
 * de las dos (resolución de asignación del evaluador, PLAN-Aliados-Epicas-PA.md PA2-W4).
 *
 * DESVIACIÓN DOCUMENTADA (contradicción con el código real, reportada — no improvisada):
 * la WU pide "los drafts publicados se eliminan de _staging/ (vía BundleStore, auditado)".
 * `src/infrastructure/bundle-store.ts` (K2-W1, cabecera del archivo) es TAJANTE: "NO se expone
 * `delete`: nunca se borra nada del bundle" — invariante de custodia (hash-chain append-only,
 * RP-07 OKF), no un descuido. `BundleStorageBackend` tampoco declara ningún método de borrado.
 * Añadir una vía de delete sería una decisión de diseño de la arquitectura de custodia que esta
 * WU no tiene mandato para tomar ("no improvisar diseño de negocio"). Por tanto: este publisher
 * NO borra los drafts de `_staging/`; quedan ahí, ya consumidos (su contenido fue copiado a
 * `paquetes/{slug}/` con confidence:'reviewed'). No afecta ningún invariante probado por WU
 * (INV-3.1/3.2/3.3/3.4/6.1 no dependen de que _staging/ quede vacío). Ver reporte de la WU.
 */

import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import matter from 'gray-matter';
import { BundleStore, FRONTMATTER_YAML_ENGINE } from '../infrastructure/bundle-store';
import { EmbeddingsClient } from '../infrastructure/embeddings';
import { validatePackage, ValidationReport } from './validator';
import { canonicalize, signManifest, KmsClient } from './signer';
import { SignAndPreserve, resolvePreserver } from './preservation';

const MAX_EMBED_INPUT_CHARS = 8000;
const MD_LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;

export interface PartnerPublishInput {
  partner_id: string;
  partner_slug: string;
  package_id: string;
  package_slug: string;
  version: number;
  draft_paths: string[];
}

export interface PartnerPublishDeps {
  pool: Pool;
  embeddings: EmbeddingsClient;
  store?: BundleStore; // inyectable para tests; default: BundleStore({tenantId: partner_id})
  kmsClient?: KmsClient; // inyectable para tests; default: KeyManagementServiceClient real (signer.ts)
  // Inyectable para tests: permite reemplazar signManifest completo (no solo el KmsClient).
  // Motivo: node:crypto no expone una primitiva pública de "firma ECDSA cruda sobre un digest
  // ya calculado" (lo que un KmsClient fake recibiría vía `asymmetricSign`) — verificado
  // empíricamente (`crypto.sign(null, digestBuffer, key)` re-hashea el buffer en vez de
  // firmarlo tal cual). Un fake con acceso directo al `canonicalJson` (en vez de solo al
  // digest) puede firmar con `createSign('sha256')` sobre el texto real, produciendo una firma
  // que si verifica con `verifyManifest`. Default: signManifest real (src/partners/signer.ts).
  signManifestFn?: typeof signManifest;
  // Capa D (NOM-151) — inyectable para tests. Default: `resolvePreserver()` (proveedor por env).
  // Solo se usa cuando NOM151_PRESERVE === 'on' (gated default-off, ver paso 4b).
  preserver?: SignAndPreserve;
}

export interface PackageManifestConcept {
  path: string;
  sha256: string;
}

export interface PackageManifest {
  package_id: string;
  package_slug: string;
  version: number;
  published_at: string;
  concepts: PackageManifestConcept[];
  manifest_sha256: string;
  signature_b64: string;
  kms_key_version: string;
}

export class PartnerPublishChainBrokenError extends Error {
  brokenAt?: number;
  constructor(brokenAt?: number) {
    super(
      `Hash-chain roto${brokenAt !== undefined ? ` en línea ${brokenAt}` : ''} — publish abortado sin escrituras [INV-3.3]`
    );
    this.name = 'PartnerPublishChainBrokenError';
    this.brokenAt = brokenAt;
  }
}

export class PartnerDraftsNotFoundError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super(`draft_paths no encontrados en _staging/: ${missing.join(', ')}`);
    this.name = 'PartnerDraftsNotFoundError';
    this.missing = missing;
  }
}

export class PartnerPublishValidationError extends Error {
  reports: ValidationReport[];
  constructor(reports: ValidationReport[], message?: string) {
    super(message ?? 'Uno o más conceptos no pasaron la validación de publicación [INV-3.1][INV-KL2]');
    this.name = 'PartnerPublishValidationError';
    this.reports = reports;
  }
}

export interface PartnerPublishPartial {
  concepts_written: string[];
  index_written: boolean;
  manifest_written: boolean;
  index_delta_committed: boolean;
  // Opcional: solo presente cuando la capa D (NOM-151) está activa (NOM151_PRESERVE === 'on').
  // Ausente en el path default-off ⇒ el shape del partial no cambia para los llamadores actuales.
  constancia_written?: boolean;
}

export class PartnerPublishPartialFailureError extends Error {
  partial: PartnerPublishPartial;
  causeMessage: string;
  constructor(partial: PartnerPublishPartial, causeMessage: string) {
    super(
      `Fallo durante la escritura del publish (pasos 3-5); estado parcial documentado, sin rollback de GCS: ${causeMessage}`
    );
    this.name = 'PartnerPublishPartialFailureError';
    this.partial = partial;
    this.causeMessage = causeMessage;
  }
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function draftSlug(draftPath: string): string {
  const base = draftPath.split('/').pop() ?? draftPath;
  return base.replace(/\.md$/i, '');
}

/**
 * Parsea frontmatter+body con el mismo engine YAML que BundleStore/validator (JSON_SCHEMA;
 * evita que js-yaml convierta timestamps ISO a Date). Devuelve null si no hay bloque `---`.
 */
function parseFrontmatterAndBody(markdown: string): { data: Record<string, any>; content: string } | null {
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
 * El publish ES el acto de aprobación: antes de validar con forPublish:true se fuerza
 * confidence:'reviewed' en memoria (el draft en _staging/ NO se muta hasta que la validación
 * completa de TODOS los conceptos del batch haya pasado). Si el frontmatter no es parseable,
 * se devuelve el markdown intacto — el validador reportará n1-frontmatter-invalido y el
 * publish abortará en 422, sin cambios, como corresponde.
 */
function withConfidenceReviewed(markdown: string): string {
  const parsed = parseFrontmatterAndBody(markdown);
  if (!parsed) return markdown;
  const data = { ...parsed.data, confidence: 'reviewed' };
  return matter.stringify(parsed.content, data, { engines: { yaml: FRONTMATTER_YAML_ENGINE } } as any);
}

/**
 * Cross-links intra-paquete → aristas del índice. Solo se registran links que resuelven a un
 * concepto de ESTE MISMO batch de publish; cualquier otra forma (externa, "../", etc.) ya
 * habría abortado el publish en la validación N3 (n3-link-externo, error). Un link "pendiente"
 * (n3-link-pendiente, warn) a un concepto fuera de este batch simplemente no genera arista.
 */
function extractIntraPackageLinkTargets(bodyText: string, knownFilenames: Set<string>): string[] {
  const targets = new Set<string>();
  for (const match of bodyText.matchAll(MD_LINK_REGEX)) {
    const target = match[2].trim();
    if (/^https?:\/\//i.test(target)) continue;
    const bare = target.split('#')[0];
    if (!/\.md$/i.test(bare)) continue;
    const filename = bare.startsWith('/') ? bare.slice(1) : bare;
    if (knownFilenames.has(filename)) targets.add(filename);
  }
  return Array.from(targets);
}

function buildPackageIndex(packageSlug: string, concepts: { filename: string; title: string; description: string }[]): string {
  const items = concepts
    .map((c) => `* [${c.title}](${c.filename}) - ${c.description}`)
    .join('\n');
  // TRD §6: portada del paquete, frontmatter SOLO okf_version:"0.1" (excepción explícita a la
  // regla general de OKF-SPEC §6 "Index files contain no frontmatter", que aplica al index.md
  // de un bundle tenant, no a la portada de un paquete de aliado).
  return `---\nokf_version: "0.1"\n---\n\n# ${packageSlug}\n\n${items}\n`;
}

interface ValidatedConcept {
  filename: string; // "{slug}.md", nombre físico dentro de paquetes/{package_slug}/
  markdown: string; // contenido final (confidence:'reviewed') a escribir
  data: Record<string, any>;
  bodyText: string;
  system: string; // tags[0]
  title: string;
  description: string;
}

async function readAndValidateDrafts(
  store: BundleStore,
  draftPaths: string[]
): Promise<ValidatedConcept[]> {
  // 2a. Leer todos los draft_paths; 404 si alguno no existe.
  const missing: string[] = [];
  const raw: { draftPath: string; filename: string; markdown: string }[] = [];
  for (const draftPath of draftPaths) {
    const obj = await store.read(draftPath);
    if (!obj) {
      missing.push(draftPath);
      continue;
    }
    raw.push({ draftPath, filename: `${draftSlug(draftPath)}.md`, markdown: obj.content });
  }
  if (missing.length > 0) throw new PartnerDraftsNotFoundError(missing);

  // 2b. Slugs duplicados dentro del mismo batch pisarían silenciosamente un concepto con otro
  // (mismo path físico en paquetes/{slug}/) — se reporta como error de validación (mismo shape
  // que el resto de findings), no se adivina cuál de los dos "gana".
  const seenFilenames = new Map<string, string[]>();
  for (const r of raw) {
    const list = seenFilenames.get(r.filename) ?? [];
    list.push(r.draftPath);
    seenFilenames.set(r.filename, list);
  }
  const duplicateReports: ValidationReport[] = [];
  for (const [filename, paths] of seenFilenames.entries()) {
    if (paths.length > 1) {
      duplicateReports.push({
        path: filename,
        valid: false,
        findings: [
          {
            rule_id: 'n3-slug-duplicado',
            level: 'n3',
            severity: 'error',
            message_es: `Dos o más drafts resuelven al mismo nombre de archivo "${filename}" dentro del paquete (${paths.join(', ')}); no se puede determinar cuál publicar.`,
          },
        ],
      });
    }
  }
  if (duplicateReports.length > 0) throw new PartnerPublishValidationError(duplicateReports);

  // 2c. El publish ES el acto de aprobación: confidence:'reviewed' en memoria ANTES de validar.
  const filesForValidation = raw.map((r) => ({
    path: r.filename,
    markdown: withConfidenceReviewed(r.markdown),
  }));
  const packagePaths = filesForValidation.map((f) => `/${f.path}`);

  const reports = validatePackage(filesForValidation, {
    level: 'n3',
    forPublish: true,
    packagePaths, // redundante con packagePaths derivados de `files` dentro de validatePackage;
                   // se pasa explícito por legibilidad (WU PA2-W4: "paths lógicos futuros del paquete").
  });

  const hasErrors = reports.some((r) => r.findings.some((f) => f.severity === 'error'));
  if (hasErrors) throw new PartnerPublishValidationError(reports);

  // 2d. Todo válido: parsear cada uno para extraer title/description/system/body.
  return filesForValidation.map((f) => {
    const parsed = parseFrontmatterAndBody(f.markdown)!; // ya validado, siempre parseable aquí
    return {
      filename: f.path,
      markdown: f.markdown,
      data: parsed.data,
      bodyText: parsed.content.trim(),
      system: String(parsed.data.tags[0]),
      title: String(parsed.data.title ?? ''),
      description: String(parsed.data.description ?? ''),
    };
  });
}

interface ConceptDbRow {
  path: string; // lógico: @{partner_slug}/{system}/{slug}.md
  gcs_path: string;
  frontmatter: Record<string, any>;
  body_text: string;
  content_sha256: string;
  altitude: number;
  system_slug: string;
}

async function writeIndexDeltaTx(
  pool: Pool,
  packageId: string,
  partnerId: string,
  version: number,
  rows: ConceptDbRow[],
  embeddingLiterals: string[],
  edges: { from_path: string; to_path: string }[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // [INV-6.1]: delete+insert del paquete en la MISMA transacción — sin ventana sin conocimiento.
    await client.query('DELETE FROM okf_partner_edges WHERE package_id = $1', [packageId]);
    await client.query('DELETE FROM okf_partner_concepts WHERE package_id = $1', [packageId]);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await client.query(
        `INSERT INTO okf_partner_concepts
           (partner_id, package_id, version, path, gcs_path, frontmatter, body_text, embedding,
            content_sha256, altitude, system_slug, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CURRENT_TIMESTAMP)`,
        [
          partnerId,
          packageId,
          version,
          row.path,
          row.gcs_path,
          JSON.stringify(row.frontmatter),
          row.body_text,
          embeddingLiterals[i],
          row.content_sha256,
          row.altitude,
          row.system_slug,
        ]
      );
    }

    for (const edge of edges) {
      await client.query(
        `INSERT INTO okf_partner_edges (package_id, from_path, to_path)
         VALUES ($1,$2,$3)
         ON CONFLICT (package_id, from_path, to_path) DO NOTHING`,
        [packageId, edge.from_path, edge.to_path]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Publica una versión de paquete de aliado: verifica cadena, valida TODOS los drafts
 * aprobados, escribe conceptos + portada, firma el manifest, e indexa el delta en una única
 * transacción SQL. Devuelve `{manifest}` completo (el panel escribe partner_package_versions).
 */
export async function publishPartnerPackage(
  input: PartnerPublishInput,
  deps: PartnerPublishDeps
): Promise<{ manifest: PackageManifest }> {
  const store = deps.store ?? new BundleStore({ tenantId: input.partner_id });

  // 1. verifyChain() — cadena rota ⇒ abort 409 + nada más [INV-3.3].
  const chain = await store.verifyChain();
  if (!chain.ok) throw new PartnerPublishChainBrokenError(chain.brokenAt);

  // 2. Leer + validar TODOS los drafts (sin escrituras todavía) — un error ⇒ 0 cambios [INV-3.1].
  const validated = await readAndValidateDrafts(store, input.draft_paths);

  const knownFilenames = new Set(validated.map((v) => v.filename));
  const filenameToLogicalPath = new Map(
    validated.map((v) => [v.filename, `@${input.partner_slug}/${v.system}/${v.filename}`])
  );

  // --- A partir de aquí puede haber escrituras parciales (GCS no soporta rollback) ---------
  const partial: PartnerPublishPartial = {
    concepts_written: [],
    index_written: false,
    manifest_written: false,
    index_delta_committed: false,
  };

  try {
    // 3. Escribir conceptos a paquetes/{package_slug}/{slug}.md (confidence:'reviewed').
    const conceptEntries: (ConceptDbRow & { filename: string; title: string; description: string })[] = [];
    const edgeSet = new Set<string>(); // "fromLogical|toLogical" para deduplicar

    for (const v of validated) {
      const gcsPath = `paquetes/${input.package_slug}/${v.filename}`;
      await store.write(gcsPath, v.markdown, { actor: 'partner-publish-api', accion: 'publish' });
      partial.concepts_written.push(gcsPath);

      const logicalPath = filenameToLogicalPath.get(v.filename)!;
      conceptEntries.push({
        filename: v.filename,
        path: logicalPath,
        gcs_path: gcsPath,
        frontmatter: v.data,
        body_text: v.bodyText,
        content_sha256: sha256Hex(v.markdown),
        altitude: Number(v.data.altitude),
        system_slug: v.system,
        title: v.title,
        description: v.description,
      });

      for (const targetFilename of extractIntraPackageLinkTargets(v.bodyText, knownFilenames)) {
        const toLogical = filenameToLogicalPath.get(targetFilename)!;
        edgeSet.add(`${logicalPath}|${toLogical}`);
      }
    }

    // Portada del paquete (TRD §6): lista de conceptos con descripciones.
    const indexMd = buildPackageIndex(
      input.package_slug,
      conceptEntries.map((c) => ({ filename: c.filename, title: c.title, description: c.description }))
    );
    await store.write(`paquetes/${input.package_slug}/index.md`, indexMd, {
      actor: 'partner-publish-api',
      accion: 'index-regen',
    });
    partial.index_written = true;

    // Nota (ver cabecera del archivo): los drafts aprobados NO se borran de _staging/ —
    // BundleStore no expone delete (invariante de custodia). Desviación documentada y
    // reportada, no improvisada.

    // 4. Manifest canónico + firma KMS (PA2-W2).
    const publishedAt = new Date().toISOString();
    const manifestBase = {
      package_id: input.package_id,
      package_slug: input.package_slug,
      version: input.version,
      published_at: publishedAt,
      concepts: conceptEntries.map((c) => ({ path: c.path, sha256: c.content_sha256 })),
    };

    const keyring = process.env.KMS_PARTNER_KEYRING;
    if (!keyring) {
      throw new Error('KMS_PARTNER_KEYRING environment variable not set — no se puede firmar el manifest.');
    }
    // Llave: partner-{partner_slug} en KMS_PARTNER_KEYRING (provisionable por PA2-W2). Se firma
    // con la versión 1 de la llave — este WU no implementa rotación/selección de versión activa
    // (fuera de alcance de PA2-W4; TRD §6.4 la deja para una WU futura de rotación).
    const keyId = `${keyring}/cryptoKeys/partner-${input.partner_slug}/cryptoKeyVersions/1`;

    const canonicalManifest = canonicalize(manifestBase);
    const signManifestFn = deps.signManifestFn ?? signManifest;
    const signature = await signManifestFn(canonicalManifest, keyId, deps.kmsClient);

    const manifest: PackageManifest = { ...manifestBase, ...signature };

    await store.write(`paquetes/${input.package_slug}/manifest.json`, JSON.stringify(manifest, null, 2), {
      actor: 'partner-publish-api',
      accion: 'publish',
    });
    partial.manifest_written = true;

    // 4b. Capa D — NOM-151: constancia de conservación sobre el manifiesto YA firmado (capa A).
    // GATED default-off (`NOM151_PRESERVE=on`): sin aliado real no se emite constancia en el path
    // vivo ("construir y aislar, no desplegar"; `main` deployable sin cambio de comportamiento).
    // Fail-closed cuando está activo: si la conservación falla, el publish aborta — una constancia
    // exigida por compliance no puede omitirse en silencio. El proveedor (kms-timestamp propio vs
    // psc-externo acreditado) lo decide `resolvePreserver` por env, no este módulo (seam agnóstico).
    if (process.env.NOM151_PRESERVE === 'on') {
      const preserver = deps.preserver ?? resolvePreserver();
      const manifestJson = JSON.stringify(manifest, null, 2);
      const constancia = await preserver.preserve({
        ref: `partner:${input.partner_slug}/package:${input.package_slug}/v${input.version}`,
        message_sha256: manifest.manifest_sha256,
        message: Buffer.from(manifestJson, 'utf8'),
      });
      await store.write(
        `paquetes/${input.package_slug}/constancia.json`,
        JSON.stringify(constancia, null, 2),
        { actor: 'partner-publish-api', accion: 'publish' }
      );
      partial.constancia_written = true;
    }

    // 5. Índice delta en UNA transacción SQL [INV-6.1]. Embeddings se calculan ANTES de abrir
    // la transacción (mismo servicio que la indexación de tenant, src/indexing/indexer.ts:
    // texto = `${title}\n${description}\n${bodyText}` truncado a 8000 chars) para no mantener
    // la transacción abierta durante llamadas de red.
    const embedInputs = conceptEntries.map((c) =>
      `${c.title}\n${c.description}\n${c.body_text}`.slice(0, MAX_EMBED_INPUT_CHARS)
    );
    const embeddingVectors = embedInputs.length > 0 ? await deps.embeddings.embed(embedInputs) : [];
    const embeddingLiterals = embeddingVectors.map((v) => `[${v.join(',')}]`);

    const edges = Array.from(edgeSet).map((key) => {
      const [from_path, to_path] = key.split('|');
      return { from_path, to_path };
    });

    await writeIndexDeltaTx(
      deps.pool,
      input.package_id,
      input.partner_id,
      input.version,
      conceptEntries.map(({ filename, title, description, ...row }) => row),
      embeddingLiterals,
      edges
    );
    partial.index_delta_committed = true;

    return { manifest };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('partner_publish_partial', {
      partner_id: input.partner_id,
      package_id: input.package_id,
      package_slug: input.package_slug,
      version: input.version,
      partial,
      error: message,
    });
    throw new PartnerPublishPartialFailureError(partial, message);
  }
}
