import { createHash } from 'crypto';
import { Pool } from 'pg';
import { chunkTextSemantic } from './semantic-chunker';
import { EmbeddingsClient, GeminiEmbeddingsClient } from '../infrastructure/embeddings';
import { MockEmbeddingsClient } from '../infrastructure/embeddings.mock';

export interface CompilerOptions {
  dbUrl?: string; // e.g. postgres://user:pass@localhost:5436/dbname
  embeddings?: EmbeddingsClient;
}

export interface DocumentMetadata {
  title: string;
  source?: string;
  [key: string]: any;
}

export interface CompileResult {
  documentId: number;
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

  public async compile(markdown: string, metadata: DocumentMetadata): Promise<CompileResult> {
    const hash = createHash('sha256').update(markdown).digest('hex');
    
    const client = await this.pool.connect();
    try {
      // 1. Idempotency Check
      const tenantId = metadata.tenantId || 'default'; // Ensure tenantId is always present
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

      await client.query('BEGIN');

      // 2. Insert Document
      const docRes = await client.query(
        'INSERT INTO documents (document_hash, content, metadata, tenant_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [hash, markdown, JSON.stringify(metadata), tenantId]
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

      await client.query(`
        INSERT INTO chunks (document_id, chunk_index, chunk_text, embedding, tenant_id) 
        SELECT * FROM UNNEST ($1::int[], $2::int[], $3::text[], $4::vector[], $5::text[])
      `, [documentIds, chunkIndexes, chunkTexts, embeddingStrs, tenantIds]);

      await client.query('COMMIT');
      
      return {
        documentId,
        hash,
        chunkCount: chunks.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // --- Registro de jobs de ingesta -------------------------------------------------
  //
  // Estos tres métodos EXISTÍAN solo como un `declare module` al final de src/server.ts
  // que se los prometía al type checker sin que nadie los implementara. Resultado: `tsc`
  // pasaba, CI pasaba, la imagen se construía, y `/v1/ingest` moría en su primera línea
  // con `engine.createIngestJob is not a function`. La ruta nunca funcionó en producción.
  // Verificado en vivo el 2026-07-19 (logs de tenant-admin-panel, 502 al subir un .md).
  //
  // Escriben en `ingest_jobs` del mismo pool que `documents`/`chunks` (DATABASE_URL).
  // Si la tabla no existe o su forma derivó respecto de las migraciones 002/003, estos
  // métodos FALLAN RUIDOSAMENTE en vez de degradar en silencio: preferimos un 500 que
  // nombra la tabla a una ingesta que reporta éxito sin dejar rastro.

  public async createIngestJob(job: IngestJobInput): Promise<string> {
    const client = await this.pool.connect();
    try {
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
    } finally {
      client.release();
    }
  }

  public async updateIngestJobStatus(jobId: string, status: string): Promise<void> {
    // `completed_at` se sella cuando el job llega a un estado terminal; 'processing' u
    // otros intermedios lo dejan intacto.
    const isTerminal = status === 'completed' || status === 'completed_with_errors' || status === 'failed';
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE ingest_jobs
            SET status = $2,
                completed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE completed_at END
          WHERE id = $1`,
        [jobId, status, isTerminal]
      );
    } finally {
      client.release();
    }
  }

  public async getIngestJobStatus(jobId: string): Promise<IngestJobRecord | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT id, tenant_id, status, requested_at, documents_count, workflow_id,
                tags, cold_tier_eligible, document_metadata, error, completed_at, created_at
           FROM ingest_jobs
          WHERE id = $1`,
        [jobId]
      );
      return res.rows.length > 0 ? (res.rows[0] as IngestJobRecord) : null;
    } finally {
      client.release();
    }
  }

  public async close() {
    await this.pool.end();
  }
}