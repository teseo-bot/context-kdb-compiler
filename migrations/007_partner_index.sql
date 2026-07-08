-- migrations/007 · origen: TRD-Aliados-Conocimiento-Certificado.md §5 · renumerada 006→007 (006 tomada por candidates_metadata)

CREATE TABLE IF NOT EXISTS okf_partner_concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id UUID NOT NULL,
    package_id UUID NOT NULL,
    version INT NOT NULL,
    path TEXT NOT NULL,
    gcs_path TEXT NOT NULL,
    frontmatter JSONB NOT NULL,
    body_text TEXT NOT NULL,
    embedding vector(768),
    fts tsvector GENERATED ALWAYS AS (to_tsvector('spanish', body_text)) STORED,
    content_sha256 TEXT NOT NULL,
    altitude SMALLINT NOT NULL CHECK (altitude BETWEEN 1 AND 5),
    system_slug TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (package_id, path)
);
CREATE INDEX IF NOT EXISTS okf_partner_concepts_embedding_idx
    ON okf_partner_concepts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS okf_partner_concepts_fts_idx ON okf_partner_concepts USING gin (fts);
CREATE INDEX IF NOT EXISTS okf_partner_concepts_pkg_idx
    ON okf_partner_concepts(partner_id, package_id, system_slug, altitude);

CREATE TABLE IF NOT EXISTS okf_partner_edges (
    package_id UUID NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    PRIMARY KEY (package_id, from_path, to_path)
);

CREATE TABLE IF NOT EXISTS kdb_partner_licenses (
    contract_id UUID PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    partner_id UUID NOT NULL,
    package_id UUID NOT NULL,
    version INT NOT NULL,
    systems TEXT[] NOT NULL,
    altitude_max INT NOT NULL CHECK (altitude_max BETWEEN 1 AND 5),
    modules TEXT[] NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','suspended','terminated','expired')),
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kdb_partner_licenses_tenant_idx ON kdb_partner_licenses(tenant_id, status);

-- ENABLE + FORCE: mismo patrón que 004_rls.sql (FORCE aplica RLS también al owner;
-- el DDL del TRD §5 omitía FORCE — el código canónico es 004).
ALTER TABLE okf_partner_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE okf_partner_concepts FORCE ROW LEVEL SECURITY;
ALTER TABLE okf_partner_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE okf_partner_edges FORCE ROW LEVEL SECURITY;
ALTER TABLE kdb_partner_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE kdb_partner_licenses FORCE ROW LEVEL SECURITY;

-- Limpieza de políticas provisionales de versiones previas de esta migración
DROP POLICY IF EXISTS partner_or_licensed_read ON okf_partner_concepts;
DROP POLICY IF EXISTS partner_edges_read ON okf_partner_edges;

-- Dos políticas PERMISSIVE sobre okf_partner_concepts: Postgres las combina con OR
-- (portal del partner dueño O tenant con licencia activa vigente).
DROP POLICY IF EXISTS partner_portal_read ON okf_partner_concepts;
CREATE POLICY partner_portal_read ON okf_partner_concepts FOR SELECT USING (
    partner_id::text = current_setting('app.partner_id', true)
);

DROP POLICY IF EXISTS licensed_tenant_read ON okf_partner_concepts;
CREATE POLICY licensed_tenant_read ON okf_partner_concepts FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM kdb_partner_licenses l
        WHERE l.partner_id = okf_partner_concepts.partner_id
          AND l.package_id = okf_partner_concepts.package_id
          AND l.tenant_id  = current_setting('app.tenant_id', true)
          AND l.status = 'active'
          AND now() >= l.valid_from AND now() < l.valid_until
          AND okf_partner_concepts.system_slug = ANY(l.systems)
          AND okf_partner_concepts.altitude <= l.altitude_max
    )
);

DROP POLICY IF EXISTS licenses_tenant_read ON kdb_partner_licenses;
CREATE POLICY licenses_tenant_read ON kdb_partner_licenses FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id', true)
);

-- Nota: escrituras solo rol de servicio del compiler (postgres, superuser/owner) —
-- sin políticas INSERT/UPDATE, mismo patrón que 004_rls.sql. El patrón de
-- idempotencia es DROP POLICY IF EXISTS + CREATE POLICY, copiado de 004_rls.sql.
-- okf_partner_edges queda sin política SELECT: con RLS activo y sin política,
-- ningún rol de aplicación ve filas (solo el rol de servicio).
