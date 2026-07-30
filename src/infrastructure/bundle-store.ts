import { createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import matter from 'gray-matter';
import * as yaml from 'js-yaml';
import { ConceptFrontmatterSchema } from './concept-frontmatter.schema';

// K3-W2: engine YAML propio para gray-matter usando js-yaml JSON_SCHEMA en vez del schema
// por defecto (CORE_SCHEMA + tipos YAML 1.1). Motivo: el schema por defecto de js-yaml
// autodetecta valores como `2026-07-01T10:00:00.000Z` (sin comillas) como tipo YAML
// `!!timestamp` y los convierte a `Date`, lo que rompe `ConceptFrontmatterSchema.timestamp`
// (`z.string().datetime()`) — el parser ad-hoc anterior nunca hacía esta coerción. JSON_SCHEMA
// preserva esos valores como string, igualando el comportamiento previo sin perder soporte de
// arrays/objetos/números que sí necesitamos.
export const FRONTMATTER_YAML_ENGINE = {
  parse: (input: string) => yaml.load(input, { schema: yaml.JSON_SCHEMA }),
  stringify: (data: object) => yaml.dump(data, { schema: yaml.JSON_SCHEMA }),
};

// K2-W1 (BACKEND §A2, TRD §2/§3/§7): cliente GCS con cadena de custodia.
//
// Reglas (BACKEND §A2):
// - `write` es la ÚNICA vía de escritura del bundle: (1) escribe el objeto, (2) append a
//   log.md con hash-chain (TRD §7), (3) usa ifGenerationMatch sobre log.md con 3 reintentos
//   (concurrencia optimista).
// - NO se expone `delete`: nunca se borra nada del bundle.
// - `write` valida frontmatter con ConceptFrontmatterSchema cuando el path termina en `.md`
//   y NO es log.md / index.md / registro-fuentes.md. Los drafts de `_staging/` SÍ se validan
//   (la exención es solo para esos 3 archivos especiales, en cualquier ubicación).

export interface LogEntry {
  timestamp: string; // ISO8601
  actor: string; // 'compiler-v2' | 'night-worker-v3' | 'hitl:{email}'
  accion: string; // 'draft' | 'merge-create' | 'merge-update' | 'index-regen' | 'mirror'
  path: string;
  contentHash: string; // sha256 hex del contenido (sin prefijo 'sha256:')
  prev: string; // sha256 de la línea de log anterior completa, o 'genesis' para la primera
}

const LOG_PATH = 'log.md';
const GENESIS = 'genesis';
const MAX_WRITE_RETRIES = 3;

const EXEMPT_BASENAMES = new Set(['log.md', 'index.md', 'registro-fuentes.md']);

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function requiresFrontmatterValidation(path: string): boolean {
  if (!path.endsWith('.md')) return false;
  return !EXEMPT_BASENAMES.has(basename(path));
}

/**
 * Formatea una entrada de log según TRD §7:
 * {ISO8601} | {actor} | {accion} | {path} | sha256:{hash_contenido} | prev:{hash_entrada_anterior}
 */
function formatLogLine(entry: LogEntry): string {
  return `${entry.timestamp} | ${entry.actor} | ${entry.accion} | ${entry.path} | sha256:${entry.contentHash} | prev:${entry.prev}`;
}

/**
 * Extrae el bloque de frontmatter YAML (entre --- ... ---) de un contenido Markdown y lo
 * parsea a un objeto plano, usando `gray-matter` (dependencia permitida desde K3-W2).
 * Deuda técnica saldada en K3-W2: reemplaza el parser ad-hoc previo (regex por línea) que
 * era provisional. Comportamiento mantenido: devuelve `null` si no hay bloque `---...---`,
 * o el objeto de frontmatter parseado (posiblemente `{}` si el bloque está vacío).
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(content)) return null;
  const { data } = matter(content, { engines: { yaml: FRONTMATTER_YAML_ENGINE } });
  return data as Record<string, unknown>;
}

// --- Interfaz mínima de storage inyectable (para tests) ---------------------------------

export interface StoredObjectMeta {
  path: string;
  generation: bigint;
}

export interface ReadResult {
  content: string;
  generation: bigint;
}

/**
 * Superficie mínima de GCS que BundleStore necesita. El default es un adaptador sobre el
 * cliente real de @google-cloud/storage; los tests inyectan una implementación en memoria.
 */
export interface BundleStorageBackend {
  read(path: string): Promise<ReadResult | null>;
  list(prefix: string): Promise<StoredObjectMeta[]>;
  /**
   * Escribe el objeto. Si `ifGenerationMatch` se provee, la escritura debe fallar (throw) con
   * un error cuyo `.code === 'GENERATION_MISMATCH'` si la generación actual del objeto en el
   * backend no coincide (o si el objeto no existe cuando se esperaba generación 0 = "no existe").
   * Devuelve la nueva generación asignada por el backend.
   */
  save(path: string, content: string, opts?: { ifGenerationMatch?: bigint }): Promise<bigint>;
}

export class GenerationMismatchError extends Error {
  code = 'GENERATION_MISMATCH';
  constructor(path: string) {
    super(`Generation mismatch al escribir ${path}`);
    this.name = 'GenerationMismatchError';
  }
}

function isGenerationMismatch(error: any): boolean {
  return (
    error?.code === 'GENERATION_MISMATCH' ||
    error?.code === 412 ||
    error?.code === '412' ||
    /precondition/i.test(String(error?.message ?? ''))
  );
}

/**
 * Adaptador por defecto sobre el cliente real de @google-cloud/storage.
 */
class GcsStorageBackend implements BundleStorageBackend {
  private storage: Storage;
  private bucketName: string;

  constructor(bucketName: string) {
    this.storage = new Storage();
    this.bucketName = bucketName;
  }

  async read(path: string): Promise<ReadResult | null> {
    const file = this.storage.bucket(this.bucketName).file(path);
    try {
      const [buf] = await file.download();
      const [metadata] = await file.getMetadata();
      const generation = BigInt(metadata.generation ?? 0);
      return { content: buf.toString('utf8'), generation };
    } catch (error: any) {
      if (error?.code === 404) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<StoredObjectMeta[]> {
    const [files] = await this.storage.bucket(this.bucketName).getFiles({ prefix });
    return files.map((f) => ({
      path: f.name,
      generation: BigInt(f.metadata.generation ?? 0),
    }));
  }

  async save(
    path: string,
    content: string,
    opts?: { ifGenerationMatch?: bigint }
  ): Promise<bigint> {
    const file = this.storage.bucket(this.bucketName).file(path);
    try {
      await file.save(content, {
        resumable: false,
        preconditionOpts:
          opts?.ifGenerationMatch !== undefined
            ? { ifGenerationMatch: opts.ifGenerationMatch.toString() }
            : undefined,
      });
      const [metadata] = await file.getMetadata();
      return BigInt(metadata.generation ?? 0);
    } catch (error: any) {
      if (error?.code === 412) throw new GenerationMismatchError(path);
      throw error;
    }
  }
}

// --- BundleStore --------------------------------------------------------------------------

export interface BundleStoreOptions {
  tenantId: string;
  /**
   * De quién es el bundle, y por tanto qué prefijo de bucket le toca. Los bundles de
   * aliado viven en `kdb-partner-<partner_id>` — es el nombre que crea el endpoint de
   * aprovisionamiento (`/internal/partner-provision`, `GCS_PARTNER_BUNDLE_PREFIX`) — y
   * los de tenant en `kdb-<tenant_id>` (`GCS_BUNDLE_PREFIX`).
   *
   * Sin esto ambos caían en el prefijo de tenant, así que todo endpoint de aliado
   * buscaba un bucket `kdb-<partner_id>` que nunca se creó: GCS devolvía 404 "The
   * specified bucket does not exist", el compiler 500 y el portal de aliados lo
   * presentaba como el 502 al subir fuente. `partner_id` se pasa en `tenantId` porque
   * el bundle de un aliado es su propio espacio de nombres (PA/ADR-203).
   */
  kind?: 'tenant' | 'partner';
  storage?: BundleStorageBackend;
}

export class BundleStore {
  readonly tenantId: string;
  readonly bucketName: string;
  private storage: BundleStorageBackend;

  constructor(opts: BundleStoreOptions) {
    this.tenantId = opts.tenantId;
    const prefix =
      opts.kind === 'partner'
        ? process.env.GCS_PARTNER_BUNDLE_PREFIX ?? 'kdb-partner-'
        : process.env.GCS_BUNDLE_PREFIX ?? 'kdb-';
    this.bucketName = `${prefix}${opts.tenantId}`;
    this.storage = opts.storage ?? new GcsStorageBackend(this.bucketName);
  }

  async read(path: string): Promise<{ content: string; generation: bigint } | null> {
    return this.storage.read(path);
  }

  async list(prefix: string): Promise<{ path: string; generation: bigint }[]> {
    return this.storage.list(prefix);
  }

  /**
   * ÚNICA vía de escritura. Hace: (1) write objeto, (2) append a log.md con hash-chain
   * (TRD §7), (3) usa ifGenerationMatch para concurrencia optimista sobre log.md
   * (reintenta 3×).
   */
  async write(
    path: string,
    content: string,
    meta: { actor: string; accion: string }
  ): Promise<void> {
    if (requiresFrontmatterValidation(path)) {
      const frontmatter = parseFrontmatter(content);
      // Si no hay bloque de frontmatter, dejar que Zod lo reporte como faltante (objeto vacío).
      ConceptFrontmatterSchema.parse(frontmatter ?? {});
    }

    await this.storage.save(path, content);

    await this.appendLog({
      timestamp: new Date().toISOString(),
      actor: meta.actor,
      accion: meta.accion,
      path,
      contentHash: sha256Hex(content),
    });
  }

  /**
   * Calcula `prev` leyendo la última línea de log.md y hace append con concurrencia
   * optimista (ifGenerationMatch), reintentando hasta 3 veces si otro escritor gana la carrera.
   */
  async appendLog(entry: Omit<LogEntry, 'prev'>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const existing = await this.storage.read(LOG_PATH);
      const currentContent = existing?.content ?? '';
      const currentGeneration = existing?.generation;

      const prev = lastLogLineHash(currentContent);
      const newLine = formatLogLine({ ...entry, prev });
      const newContent = currentContent === '' ? `${newLine}\n` : `${currentContent}${newLine}\n`;

      try {
        await this.storage.save(LOG_PATH, newContent, {
          ifGenerationMatch: currentGeneration ?? 0n,
        });
        return;
      } catch (error) {
        if (isGenerationMismatch(error)) {
          lastError = error;
          continue; // reintentar leyendo el estado más reciente
        }
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('appendLog: agotados los reintentos por conflicto de generación');
  }

  /**
   * Recomputa la cadena de log.md de arriba a abajo; cualquier discrepancia = alerta crítica.
   */
  async verifyChain(): Promise<{ ok: boolean; brokenAt?: number }> {
    const existing = await this.storage.read(LOG_PATH);
    const content = existing?.content ?? '';
    const lines = content.split(/\r?\n/).filter((l) => l.length > 0);

    let expectedPrev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prevMatch = line.match(/prev:(\S+)$/);
      const actualPrev = prevMatch ? prevMatch[1] : undefined;
      if (actualPrev !== expectedPrev) {
        return { ok: false, brokenAt: i };
      }
      expectedPrev = sha256Hex(line);
    }

    return { ok: true };
  }
}

function lastLogLineHash(logContent: string): string {
  const lines = logContent.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return GENESIS;
  return sha256Hex(lines[lines.length - 1]);
}
