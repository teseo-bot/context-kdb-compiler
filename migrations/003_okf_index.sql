-- Fix del typo de 002 (TIMESTANDP) de forma idempotente
ALTER TABLE ingest_jobs DROP COLUMN IF EXISTS created_at;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- Índice del wiki: un registro por concepto vivo
CREATE TABLE IF NOT EXISTS okf_concepts (
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
CREATE INDEX IF NOT EXISTS okf_concepts_embedding_idx
    ON okf_concepts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS okf_concepts_fts_idx ON okf_concepts USING gin (fts);
CREATE INDEX IF NOT EXISTS okf_concepts_tenant_system_idx ON okf_concepts(tenant_id, system_slug, altitude);

-- Grafo de cross-links
CREATE TABLE IF NOT EXISTS okf_edges (
    tenant_id TEXT NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    PRIMARY KEY (tenant_id, from_path, to_path)
);

-- Linaje concepto → fuente
CREATE TABLE IF NOT EXISTS okf_provenance (
    tenant_id TEXT NOT NULL,
    concept_path TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    PRIMARY KEY (tenant_id, concept_path, source_ref)
);

-- Cola V1 → V2
CREATE TABLE IF NOT EXISTS knowledge_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('conversation_closed','document_ingested','event')),
    source_ref TEXT NOT NULL,
    payload_summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','drafted','discarded','error')),
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS knowledge_candidates_status_idx ON knowledge_candidates(tenant_id, status);

-- Cola HITL de merges
CREATE TABLE IF NOT EXISTS okf_merge_proposals (
    proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    target_path TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','update')),
    altitude SMALLINT NOT NULL CHECK (altitude BETWEEN 1 AND 5),
    draft_ids UUID[] NOT NULL,
    new_content TEXT NOT NULL,
    previous_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'pending_auto'
        CHECK (status IN ('pending_auto','pending_hitl','approved','rejected','applied')),
    reviewer TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS okf_merge_proposals_status_idx ON okf_merge_proposals(tenant_id, status);

-- Evals doradas
CREATE TABLE IF NOT EXISTS okf_golden_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    question TEXT NOT NULL,
    reference_answer TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS okf_eval_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    run_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    score NUMERIC(5,2) NOT NULL,           -- 0-100
    details JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_version TEXT
);

-- Columna review_meta para HITL (BACKEND §D2)
ALTER TABLE okf_merge_proposals ADD COLUMN IF NOT EXISTS review_meta JSONB DEFAULT '{}'::jsonb;
