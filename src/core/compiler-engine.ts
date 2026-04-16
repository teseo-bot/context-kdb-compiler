import { createHash } from 'crypto';
import { Pool } from 'pg';
import { chunkTextSemantic } from './semantic-chunker';

export interface CompilerOptions {
  dbUrl?: string; // e.g. postgres://user:pass@localhost:5436/dbname
  vertexAiEndpoint?: string;
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

export class CompilerEngine {
  private pool: Pool;
  private endpoint: string;

  constructor(opts?: CompilerOptions) {
    this.pool = new Pool({
      connectionString: opts?.dbUrl || 'postgres://postgres:postgres@localhost:5436/postgres',
    });
    this.endpoint = opts?.vertexAiEndpoint || 'http://localhost:3000/fleetco-AI-gateway/embeddings';
  }

  public async initDb() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id SERIAL PRIMARY KEY,
          document_hash TEXT UNIQUE NOT NULL,
          content TEXT NOT NULL,
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // Attempt to create vector extension, ignores error if not supported/installed
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`).catch(() => {});

      await client.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          id SERIAL PRIMARY KEY,
          document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          chunk_text TEXT NOT NULL,
          embedding vector(768),
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
    } finally {
      client.release();
    }
  }

  public async compile(markdown: string, metadata: DocumentMetadata): Promise<CompileResult> {
    const hash = createHash('sha256').update(markdown).digest('hex');
    
    const client = await this.pool.connect();
    try {
      // 1. Idempotency Check
      const existing = await client.query('SELECT id FROM documents WHERE document_hash = $1', [hash]);
      if (existing.rows.length > 0) {
        console.log(`Document already compiled with hash: ${hash}`);
        const chunksRes = await client.query('SELECT count(*) FROM chunks WHERE document_id = $1', [existing.rows[0].id]);
        return {
          documentId: existing.rows[0].id,
          hash,
          chunkCount: parseInt(chunksRes.rows[0].count, 10),
        };
      }

      await client.query('BEGIN');

      // 2. Insert Document
      const docRes = await client.query(
        'INSERT INTO documents (document_hash, content, metadata) VALUES ($1, $2, $3) RETURNING id',
        [hash, markdown, JSON.stringify(metadata)]
      );
      const documentId = docRes.rows[0].id;

      // 3. Chunking
      const chunks = await chunkTextSemantic(markdown, {
        chunkSize: 300,
        chunkOverlap: 50,
        // Embed fn that feeds the chunker to find boundaries
        embedFn: async (sentences: string[]) => {
          return this.mockEmbeddingsCall(sentences);
        }
      });

      // 4. Embed Final Chunks & Insert
      const chunkTextsForEmbed = chunks.map(c => c.text);
      const embeddings = await this.mockEmbeddingsCall(chunkTextsForEmbed);

      const documentIds = Array(chunks.length).fill(documentId);
      const chunkIndexes = chunks.map(c => c.index);
      const chunkTexts = chunks.map(c => c.text);
      const embeddingStrs = embeddings.map(e => '[' + e.join(',') + ']');

      await client.query(`
        INSERT INTO chunks (document_id, chunk_index, chunk_text, embedding) 
        SELECT * FROM UNNEST ($1::int[], $2::int[], $3::text[], $4::vector[])
      `, [documentIds, chunkIndexes, chunkTexts, embeddingStrs]);

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

  private async mockEmbeddingsCall(texts: string[]): Promise<number[][]> {
    // Simulating a fetch to fleetco-AI-gateway -> Vertex AI
    // We will return a fake 768-dimensional vector
    return texts.map(text => {
      // Create deterministic fake embedding based on text length and some pseudo-randomness
      const vector = new Array(768).fill(0).map((_, i) => {
        return (Math.sin(text.length + i) + 1) / 2; // Values between 0 and 1
      });
      return vector;
    });
  }

  public async close() {
    await this.pool.end();
  }
}