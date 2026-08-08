import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { chunkTextSemantic } from './semantic-chunker';
import { EmbeddingsClient, GeminiEmbeddingsClient } from '../infrastructure/embeddings';
import { MockEmbeddingsClient } from '../infrastructure/embeddings.mock';
import { normalizeBrandSlugs } from '../infrastructure/brand-slugs';

export interface CompilerOptions {
  dbUrl?: string; // e.g. postgres://user:pass@localhost:5436/dbname
  embeddings?: EmbeddingsClient;
  /** Tope de conexiones del pool. Sin él: `COMPILER_POOL_MAX`, y en su defecto 2 (ADR-213 D-213.2). */
  poolMax?: number;
}

export interface DocumentMetadata {
  title: string;
  source?: string;
  /**
   * ADR-215 WU-4.4 — marcas a las que pertenece el documento.
   *
   * Se extrae ANTES de serializar `metadata` a JSON y se escribe en la COLUMNA `brand_slugs`
   * de `documents` y `chunks`. Dentro del JSON sería invisible para el `WHERE` de la
   * recuperación, que es el único sitio donde la marca sirve para algo.
   *
   * Ausente o vacío = COMPARTIDO, visible para todas las marcas ([INV-215.5]).
   */
  brandSlugs?: string[];
  [key: string]: any;
}

// WU-4.4: `normalizeBrandSlugs` se movió a `infrastructure/brand-slugs.ts` al aparecer el segundo
// consumidor (el indexador OKF). Ver allí por qué vive en un solo sitio.

export interface CompileResult {
  documentId: string; // uuid — `documents.id` es UUID (migración 001), no un serial int
  hash: string;
  chunkCount: number;
}

/** Alta de un job de ingesta. Espeja las columnas de `ingest_jobs` (migración 002 + 003). */
export interface IngestJobInput {
  tenant_id: string;
  status: string;
  requested_at: string;
  documents_count: number;
  workflow_id?: string;
  tags?: string[];
  cold_tier_eligible?: boolean;
  document_metadata: Array<{ document_id: string; metadata?: Record<string, any> }>;
}

export interface IngestJobRecord {
  id: string;
  tenant_id: string;
  status: string;
  requested_at: string;
  documents_count: number;
  workflow_id: string | null;
  tags: string[];
  cold_tier_eligible: boolean;
  document_metadata: Array<{ document_id: string; metadata?: Record<string, any> }>;
  error: string | null;
  completed_at: string | null;
  created_at: string;
}

export class CompilerEngine {
  private pool: Pool;
  private embeddings: EmbeddingsClient;

  constructor(opts?: CompilerOptions) {
    this.pool = new Pool({
      connectionString: opts?.dbUrl || 'postgres://postgres:postgres@localhost:5436/postgres',
      // ADR-213 D-213.2 — ver la nota extensa en server.ts (indexerPool). Sin `max` declarado
      // este pool solo aportaría 10 conexiones por instancia, y en la fase B del retiro apunta
      // a una base con 47 utilizables ya casi repartidas.
      max: opts?.poolMax ?? (Number.parseInt(process.env.COMPILER_POOL_MAX || '', 10) || 2),
    });
    // K0-W1: embeddings reales por default; mock SOLO bajo NODE_ENV==='test'.
    this.embeddings =
      opts?.embeddings ??
      (process.env.NODE_ENV === 'test' ? new MockEmbeddingsClient() : new GeminiEmbeddingsClient());
  }

  /**
   * Verifica la conexión al Cold-Tier. Las migraciones deben aplicarse
   * externamente vía context-kdb-compiler/migrations/. No crea esquemas en runtime.
   */
  public async initDb() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      console.log('✅ Conexión a Cold-Tier verificada. Las migraciones deben aplicarse externamente.');
    } finally {
      client.release();
    }
  }

  /**
   * Ejecuta `fn` sobre una conexión con `app.tenant_id` fijado a `tenantId`, y lo resetea al
   * soltarla. Obligatorio en el Cold-Tier: `documents`/`chunks`/`ingest_jobs` tienen RLS FORCE
   * (migración 004) con `USING (tenant_id = current_setting('app.tenant_id', true))`. Sin este
   * contexto los INSERT/UPDATE/SELECT afectan 0 filas —en silencio— aun siendo dueño de la tabla.
   * Mismo patrón que exige el encabezado de 004 y que usan los tests del indexer.
   */
  private async withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenantId]);
      return await fn(client);
    } finally {
      try {
        await client.query('RESET app.tenant_id');
      } catch {
        // La conexión pudo quedar abortada; el pool la reciclará. No enmascarar el error real.
      }
      client.release();
    }
  }

  public async compile(markdown: string, metadata: DocumentMetadata): Promise<CompileResult> {
    const hash = createHash('sha256').update(markdown).digest('hex');
    const tenantId = metadata.tenantId || 'default'; // Ensure tenantId is always present

    return this.withTenant(tenantId, async (client) => {
      // 1. Idempotency Check
      const existing = await client.query('SELECT id FROM documents WHERE document_hash = $1 AND tenant_id = $2', [hash, tenantId]);
      if (existing.rows.length > 0) {
        console.log(`Document already compiled with hash: ${hash} for tenant ${tenantId}`);
        const chunksRes = await client.query('SELECT count(*) FROM chunks WHERE document_id = $1 AND tenant_id = $2', [existing.rows[0].id, tenantId]);
        return {
          documentId: existing.rows[0].id,
          hash,
          chunkCount: parseInt(chunksRes.rows[0].count, 10),
        };
      }

      try {
        await client.query('BEGIN');

        // 2. Insert Document
        // ADR-215 WU-4.4: `brandSlugs` sale de metadata ANTES de serializar — va a su propia
        // columna, no al JSON. Guardarlo en los dos sitios invitaría a que divergieran.
        const { brandSlugs: _brandSlugsRaw, ...metadataSinMarca } = metadata;
        const brandSlugs = normalizeBrandSlugs(metadata.brandSlugs);

        const docRes = await client.query(
          'INSERT INTO documents (document_hash, content, metadata, tenant_id, brand_slugs) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [hash, markdown, JSON.stringify(metadataSinMarca), tenantId, brandSlugs]
        );
        const documentId = docRes.rows[0].id;

        // 3. Chunking
        const chunks = await chunkTextSemantic(markdown, {
          chunkSize: 300,
          chunkOverlap: 50,
          // Embed fn that feeds the chunker to find boundaries
          embedFn: async (sentences: string[]) => {
            return this.embeddings.embed(sentences);
          }
        });

        // 4. Embed Final Chunks & Insert
        const chunkTextsForEmbed = chunks.map(c => c.text);
        const embeddings = await this.embeddings.embed(chunkTextsForEmbed);

        const documentIds = Array(chunks.length).fill(documentId);
        const chunkIndexes = chunks.map(c => c.index);
        const chunkTexts = chunks.map(c => c.text);
        const embeddingStrs = embeddings.map(e => '[' + e.join(',') + ']');
        const tenantIds = Array(chunks.length).fill(tenantId); // Array of tenantIds for chunks

        // `document_id` es UUID (migración 001), no int: el cast debe ser `::uuid[]`. Con `::int[]`
        // el INSERT reventaba en cuanto compile() por fin escribía en un esquema real —bug apilado
        // detrás del de la BD equivocada; nunca se ejecutó porque /v1/ingest no llegaba hasta aquí.
        // ADR-215 WU-4.4: los chunks HEREDAN la marca del documento. No se pasa por UNNEST
        // —sería el mismo array repetido n veces, y un text[] dentro de UNNEST se aplana— sino
        // como constante del SELECT: todos los chunks de un documento comparten su marca por
        // definición.
        await client.query(`
          INSERT INTO chunks (document_id, chunk_index, chunk_text, embedding, tenant_id, brand_slugs)
          SELECT *, $6::text[] FROM UNNEST ($1::uuid[], $2::int[], $3::text[], $4::vector[], $5::text[])
        `, [documentIds, chunkIndexes, chunkTexts, embeddingStrs, tenantIds, brandSlugs]);

        await client.query('COMMIT');

        return {
          documentId,
          hash,
          chunkCount: chunks.length,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  // --- Registro de jobs de ingesta -------------------------------------------------
  //
  // Estos tres métodos EXISTÍAN solo como un `declare module` al final de src/server.ts
  // que se los prometía al type checker sin que nadie los implementara. Resultado: `tsc`
  // pasaba, CI pasaba, la imagen se construía, y `/v1/ingest` moría en su primera línea
  // con `engine.createIngestJob is not a function`. La ruta nunca funcionó en producción.
  // Verificado en vivo el 2026-07-19 (logs de tenant-admin-panel, 502 al subir un .md).
  //
  // Escriben en `ingest_jobs` del mismo pool que `documents`/`chunks` (COLD_TIER_URL — el corpus
  // vive en el Cold-Tier). La tabla está bajo RLS FORCE (migración 004): todas pasan por
  // `withTenant`, o el INSERT/UPDATE/SELECT afecta 0 filas en silencio. Si la tabla no existe o su
  // forma derivó respecto de las migraciones 002/003, FALLAN RUIDOSAMENTE en vez de degradar en
  // silencio: preferimos un 500 que nombra la tabla a una ingesta que reporta éxito sin dejar rastro.

  public async createIngestJob(job: IngestJobInput): Promise<string> {
    return this.withTenant(job.tenant_id, async (client) => {
      const res = await client.query(
        `INSERT INTO ingest_jobs
           (tenant_id, status, requested_at, documents_count,
            workflow_id, tags, cold_tier_eligible, document_metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
         RETURNING id`,
        [
          job.tenant_id,
          job.status,
          job.requested_at,
          job.documents_count,
          job.workflow_id ?? null,
          JSON.stringify(job.tags ?? []),
          job.cold_tier_eligible ?? false,
          JSON.stringify(job.document_metadata ?? []),
        ]
      );
      return res.rows[0].id as string;
    });
  }

  public async updateIngestJobStatus(jobId: string, status: string, tenantId: string): Promise<void> {
    // `completed_at` se sella cuando el job llega a un estado terminal; 'processing' u
    // otros intermedios lo dejan intacto.
    const isTerminal = status === 'completed' || status === 'completed_with_errors' || status === 'failed';
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE ingest_jobs
            SET status = $2,
                completed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE completed_at END
          WHERE id = $1`,
        [jobId, status, isTerminal]
      );
    });
  }

  public async getIngestJobStatus(jobId: string, tenantId?: string): Promise<IngestJobRecord | null> {
    // Sin `tenantId` bajo RLS FORCE el SELECT devuelve null. El caller (ruta /v1/jobs/:id) debe
    // propagar `?tenant_id=`; se deja opcional para no romper el tipo, pero es requerido en prod.
    const run = async (client: PoolClient) => {
      const res = await client.query(
        `SELECT id, tenant_id, status, requested_at, documents_count, workflow_id,
                tags, cold_tier_eligible, document_metadata, error, completed_at, created_at
           FROM ingest_jobs
          WHERE id = $1`,
        [jobId]
      );
      return res.rows.length > 0 ? (res.rows[0] as IngestJobRecord) : null;
    };
    if (tenantId) return this.withTenant(tenantId, run);
    const client = await this.pool.connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  }

  public async close() {
    await this.pool.end();
  }
}