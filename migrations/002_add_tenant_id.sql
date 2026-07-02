-- F-H2: Aislamiento multitenant del Cold-Tier
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Índices para filtrado por tenant
CREATE INDEX IF NOT EXISTS documents_tenant_id_idx ON documents(tenant_id);
CREATE INDEX IF NOT EXISTS chunks_tenant_id_idx ON chunks(tenant_id);

-- Idempotencia: hash único por tenant (no global)
-- Nota: documents_document_hash_key es una constraint UNIQUE, no un índice,
-- así que usamos ALTER TABLE para remover la constraint
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_document_hash_key;
CREATE UNIQUE INDEX IF NOT EXISTS documents_tenant_hash_uniq
  ON documents(tenant_id, document_hash);

-- Tabla de ingest_jobs
CREATE TABLE IF NOT EXISTS ingest_jobs (
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

CREATE INDEX IF NOT EXISTS ingest_jobs_tenant_id_idx ON ingest_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS ingest_jobs_status_idx ON ingest_jobs(status);

-- Idempotencia de jobs
CREATE UNIQUE INDEX IF NOT EXISTS ingest_jobs_tenant_idempotency_uniq
  ON ingest_jobs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;