-- Patrón RLS: aislamiento por tenant_id para 10 tablas
-- Regla de conexión: todo cliente Postgres ejecuta SET app.tenant_id = '{tenant_id}'
-- inmediatamente tras obtener la conexión, y RESET app.tenant_id al devolverla.

-- documents
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents
    USING (tenant_id = current_setting('app.tenant_id', true));

-- chunks
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chunks_tenant_isolation ON chunks;
CREATE POLICY chunks_tenant_isolation ON chunks
    USING (tenant_id = current_setting('app.tenant_id', true));

-- ingest_jobs
ALTER TABLE ingest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ingest_jobs_tenant_isolation ON ingest_jobs;
CREATE POLICY ingest_jobs_tenant_isolation ON ingest_jobs
    USING (tenant_id = current_setting('app.tenant_id', true));

-- okf_concepts
ALTER TABLE okf_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE okf_concepts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS okf_concepts_tenant_isolation ON okf_concepts;
CREATE POLICY okf_concepts_tenant_isolation ON okf_concepts
    USING (tenant_id = current_setting('app.tenant_id', true));

-- okf_edges
ALTER TABLE okf_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE okf_edges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS okf_edges_tenant_isolation ON okf_edges;
CREATE POLICY okf_edges_tenant_isolation ON okf_edges
    USING (tenant_id = current_setting('app.tenant_id', true));

-- okf_provenance
ALTER TABLE okf_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE okf_provenance FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS okf_provenance_tenant_isolation ON okf_provenance;
CREATE POLICY okf_provenance_tenant_isolation ON okf_provenance
    USING (tenant_id = current_setting('app.tenant_id', true));

-- knowledge_candidates
ALTER TABLE knowledge_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_candidates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_candidates_tenant_isolation ON knowledge_candidates;
CREATE POLICY knowledge_candidates_tenant_isolation ON knowledge_candidates
    USING (tenant_id = current_setting('app.tenant_id', true));

-- okf_merge_proposals
ALTER TABLE okf_merge_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE okf_merge_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS okf_merge_proposals_tenant_isolation ON okf_merge_proposals;
CREATE POLICY okf_merge_proposals_tenant_isolation ON okf_merge_proposals
    USING (tenant_id = current_setting('app.tenant_id', true));

-- okf_golden_questions
ALTER TABLE okf_golden_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE okf_golden_questions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS okf_golden_questions_tenant_isolation ON okf_golden_questions;
CREATE POLICY okf_golden_questions_tenant_isolation ON okf_golden_questions
    USING (tenant_id = current_setting('app.tenant_id', true));

-- okf_eval_runs
ALTER TABLE okf_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE okf_eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS okf_eval_runs_tenant_isolation ON okf_eval_runs;
CREATE POLICY okf_eval_runs_tenant_isolation ON okf_eval_runs
    USING (tenant_id = current_setting('app.tenant_id', true));
