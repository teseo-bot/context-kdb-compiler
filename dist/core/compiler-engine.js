"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompilerEngine = void 0;
const crypto_1 = require("crypto");
const pg_1 = require("pg");
const semantic_chunker_1 = require("./semantic-chunker");
const embeddings_1 = require("../infrastructure/embeddings");
const embeddings_mock_1 = require("../infrastructure/embeddings.mock");
class CompilerEngine {
    pool;
    embeddings;
    constructor(opts) {
        this.pool = new pg_1.Pool({
            connectionString: opts?.dbUrl || 'postgres://postgres:postgres@localhost:5436/postgres',
        });
        // K0-W1: embeddings reales por default; mock SOLO bajo NODE_ENV==='test'.
        this.embeddings =
            opts?.embeddings ??
                (process.env.NODE_ENV === 'test' ? new embeddings_mock_1.MockEmbeddingsClient() : new embeddings_1.GeminiEmbeddingsClient());
    }
    /**
     * Verifica la conexión al Cold-Tier. Las migraciones deben aplicarse
     * externamente vía context-kdb-compiler/migrations/. No crea esquemas en runtime.
     */
    async initDb() {
        const client = await this.pool.connect();
        try {
            await client.query('SELECT 1');
            console.log('✅ Conexión a Cold-Tier verificada. Las migraciones deben aplicarse externamente.');
        }
        finally {
            client.release();
        }
    }
    async compile(markdown, metadata) {
        const hash = (0, crypto_1.createHash)('sha256').update(markdown).digest('hex');
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
            const docRes = await client.query('INSERT INTO documents (document_hash, content, metadata, tenant_id) VALUES ($1, $2, $3, $4) RETURNING id', [hash, markdown, JSON.stringify(metadata), tenantId]);
            const documentId = docRes.rows[0].id;
            // 3. Chunking
            const chunks = await (0, semantic_chunker_1.chunkTextSemantic)(markdown, {
                chunkSize: 300,
                chunkOverlap: 50,
                // Embed fn that feeds the chunker to find boundaries
                embedFn: async (sentences) => {
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
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async close() {
        await this.pool.end();
    }
}
exports.CompilerEngine = CompilerEngine;
