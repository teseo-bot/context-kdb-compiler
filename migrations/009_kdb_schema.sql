-- 009_kdb_schema.sql — plano de conocimiento PRIVADO del tenant (ADR-210 D-210.2)
--
-- Se aplica en la instancia DEL TENANT (micontexto-tenant{N}:hot-tier), NO en el
-- Cold-Tier compartido. Junto al schema `ops` (leads/inbox/checkpoints/negocio) esto
-- completa los "dos cajones del mismo archivero": una sola instancia Cloud SQL por
-- tenant, con su CMEK, y el conocimiento privado dentro de ella.
--
-- DERIVADO MECÁNICAMENTE de 001_init + 002_add_tenant_id + 003_okf_index: mismos
-- objetos, mismos tipos, mismas claves e índices (con el mismo método), calificados
-- con el schema `kdb`. No se inventó ninguna columna.
--
-- TRES desviaciones deliberadas respecto al DDL original, todas registradas:
--
--   1. `tenant_id` SIN `DEFAULT 'default'`. En el original, un INSERT que olvide el
--      tenant no falla: la fila aterriza en un tenant fantasma llamado 'default' que
--      bajo RLS es invisible para todos, así que el síntoma es "desapareció" en vez
--      de un error. Aquí el olvido falla en seco. (Ver VERIF-V2-Pgvector-Indice.md.)
--
--   2. Se reproduce el ESTADO FINAL, no la secuencia histórica. 002 quitaba el UNIQUE
--      global de `documents.document_hash` para poner uno compuesto por tenant, y 003
--      hacía DROP/ADD de `ingest_jobs.created_at` para corregir un typo de 002. En un
--      schema virgen esos pasos no tienen sentido: se crea directamente el resultado.
--
--   3. Los índices llevan prefijo `kdb_` para no colisionar si algún día conviven con
--      los de `public` en la misma base.
--
-- ALCANCE: solo las 6 tablas del corpus privado. Deliberadamente NO incluye lo de
-- aliados (`okf_partner_*`, `kdb_partner_licenses`, migraciones 007/008), que se queda
-- en el Cold-Tier compartido por diseño (ADR-203: se compila 1× y se licencia por
-- referencia, nunca se copia). Ver la nota de alcance pendiente al final del archivo.

CREATE SCHEMA IF NOT EXISTS kdb;

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Corpus vectorial ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kdb.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    filename TEXT,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS kdb_documents_tenant_id_idx ON kdb.documents(tenant_id);
-- Idempotencia por tenant, no global (002).
CREATE UNIQUE INDEX IF NOT EXISTS kdb_documents_tenant_hash_uniq
    ON kdb.documents(tenant_id, document_hash);

CREATE TABLE IF NOT EXISTS kdb.chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    document_id UUID REFERENCES kdb.documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding vector(768),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS kdb_chunks_document_id_idx ON kdb.chunks(document_id);
CREATE INDEX IF NOT EXISTS kdb_chunks_tenant_id_idx ON kdb.chunks(tenant_id);
-- Mismo método que el original: HNSW con distancia coseno.
-- NOTA (VERIF-V2): en el plano compartido este índice sufría colapso de recall — el
-- recorrido devolvía los k vecinos de TODA la tabla y el filtro por tenant se aplicaba
-- después, así que un tenant grande degradaba las respuestas de los pequeños. Aquí el
-- problema desaparece por construcción: un índice por tenant no tiene vecinos.
CREATE INDEX IF NOT EXISTS kdb_chunks_embedding_hnsw_idx
    ON kdb.chunks USING hnsw (embedding vector_cosine_ops);

-- ── Índice del wiki OKF ─────────────────────────────────────────────────────────
-- ⚠️ FUENTE DE VERDAD = el árbol de archivos .md en el bucket del tenant, NO esta
-- tabla (ADR-210 D-210.6; OKF es especificación abierta de Google Cloud). Esto es una
-- PROYECCIÓN DERIVADA, reconstruible reingiriendo el árbol: `gcs_generation` es el
-- token de concurrencia optimista del objeto de GCS y `content_sha256` permite
-- compararlo contra la fuente. En una migración, esto se RE-DERIVA, no se migra.

CREATE TABLE IF NOT EXISTS kdb.okf_concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    path TEXT NOT NULL,                    -- ej. 'c-comercial/objeciones-precio.md'
    frontmatter JSONB NOT NULL,
    body_text TEXT NOT NULL,
    embedding vector(768),
    fts tsvector GENERATED ALWAYS AS (to_tsvector('spanish', body_text)) STORED,
    content_sha256 TEXT NOT NULL,
    gcs_generation BIGINT,                 -- generation de GCS del objeto indexado
    altitude SMALLINT NOT NULL CHECK (altitude BETWEEN 1 AND 5),
    system_slug TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, path)
);
CREATE INDEX IF NOT EXISTS kdb_okf_concepts_embedding_idx
    ON kdb.okf_concepts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS kdb_okf_concepts_fts_idx ON kdb.okf_concepts USING gin (fts);
CREATE INDEX IF NOT EXISTS kdb_okf_concepts_tenant_system_idx
    ON kdb.okf_concepts(tenant_id, system_slug, altitude);

-- Grafo de cross-links. Son los enlaces markdown del árbol OKF, materializados.
-- Una arista hacia un concepto de ALIADO no vive aquí: es un enlace que se resuelve
-- en lectura contra `kdb_partner_licenses` del Cold-Tier (ADR-210 D-210.6), así que
-- no hace falta integridad referencial cross-project.
CREATE TABLE IF NOT EXISTS kdb.okf_edges (
    tenant_id TEXT NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    PRIMARY KEY (tenant_id, from_path, to_path)
);

-- Linaje concepto → fuente.
CREATE TABLE IF NOT EXISTS kdb.okf_provenance (
    tenant_id TEXT NOT NULL,
    concept_path TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    PRIMARY KEY (tenant_id, concept_path, source_ref)
);

-- ── Estado de ingesta ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kdb.ingest_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    documents_count INTEGER DEFAULT 0,
    workflow_id TEXT,
    tags JSONB DEFAULT '[]'::jsonb,
    cold_tier_eligible BOOLEAN DEFAULT FALSE,
    document_metadata JSONB DEFAULT '[]'::jsonb,
    error TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS kdb_ingest_jobs_tenant_id_idx ON kdb.ingest_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS kdb_ingest_jobs_status_idx ON kdb.ingest_jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS kdb_ingest_jobs_tenant_idempotency_uniq
    ON kdb.ingest_jobs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════════
-- ALCANCE PENDIENTE DE DECISIÓN — no incluido a propósito, no por olvido.
--
-- Estas cuatro tablas de 003_okf_index.sql también llevan `tenant_id` y son estado de
-- trabajo por tenant, pero quedaron FUERA porque el spec de SB2-W1 fijaba seis tablas
-- y ampliarlo en silencio en una migración con implicaciones de aislamiento sería
-- exactamente el tipo de decisión que no debe tomarse de paso:
--
--   · kdb.knowledge_candidates   cola V1→V2 del destilador. RECOMENDACIÓN: SÍ baja.
--                                Con el destilador por tenant (D-210.4), su cola debe
--                                vivir en el plano del tenant.
--   · kdb.okf_merge_proposals    cola HITL de merges (+ columna review_meta de 003).
--                                RECOMENDACIÓN: SÍ baja, mismo argumento.
--   · okf_golden_questions       AMBIGUO. 008_partner_eval.sql les añade `package_id`
--   · okf_eval_runs              para el gate de eval de paquetes de ALIADOS, así que
--                                hoy son de doble uso: eval del tenant y eval de
--                                paquete de aliado. Partirlas o duplicarlas es una
--                                decisión de producto, no de esquema.
--
-- Cuando se decida, va en una migración aparte (011+), nunca editando esta.
-- ════════════════════════════════════════════════════════════════════════════════
