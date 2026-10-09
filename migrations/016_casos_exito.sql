-- 016_casos_exito.sql — los casos de éxito que escriben los aliados proveedores (ADR-224 D-224.1–D-224.3)
--
-- QUÉ ES. En cada evento MagIA el entrevistador de tenant2 deja en la ficha del lead su sector,
-- su dolor y su interés. Dentro de las 24 h siguientes se le muestra un caso de éxito de una
-- empresa parecida, escrito por el proveedor que hizo la implementación y curado por micontexto.
-- Esta migración crea el almacén de esos casos. La selección (JEV), el envío y el registro de
-- referidos viven en otros sitios: el contrato de referidos y el registro, en el plano de
-- control (multitenant-admin-panel/migrations-gcp/019).
--
-- DÓNDE SE APLICA. En el Cold-Tier (`micontexto-coldtier:us-central1:context-kdb-db`), junto a
-- `okf_partner_concepts` (007), porque es el plano de aliados. NO va en el hot-tier de un tenant:
-- un caso publicado es material de un aliado que leen varios tenants.
--
-- POR QUÉ 016 Y NO 015. La 015 está tomada por las columnas de ciclo de vida del ADR-222, que a
-- 2026-10-08 sólo existen en la rama local `feat/adr-222-ciclo-vida` (commit 7e86659, sin push).
-- Saltarla evita dos archivos 015 cuando esa rama llegue a main.
--
-- DOS TABLAS, MISMO PATRÓN QUE partner_packages / partner_package_versions:
--   · `casos_exito`: la cabeza editable del caso (borrador → en_revision → publicado → retirado).
--   · `casos_exito_versiones`: una fila INMUTABLE por publicación. Es lo que prueba qué vio el lead
--     cuando se cobra un fee: `partner_lead_referrals.case_version` apunta aquí.
--
-- EL ENCABEZADO VA ENTERO EN JSONB. Su forma la valida `CasoFrontmatterSchema` (contracts/src/casos.ts).
-- `sector` y `tamano` se derivan como columnas generadas para el filtro duro del paso 1 de D-224.4;
-- bloques HOCFLIT y tecnologías se filtran contra el JSONB por contención, que es lo que usa el
-- índice GIN (`frontmatter @> '{"bloques_hocflit":["C1"]}'`). Una sola fuente, sin columnas que copiar.
--
-- INVARIANTES QUE GUARDA LA BASE, NO SÓLO EL CÓDIGO:
--   · un caso publicado tiene versión publicada, embedding, nota del consultor y curador (D-224.2:
--     ningún caso se publica sin curaduría humana);
--   · la versión publicada existe en `casos_exito_versiones` (FK compuesta);
--   · una versión publicada no se reescribe (trigger) y no se borra mientras sea la vigente (FK).
--
-- ESCRITURAS. Sólo el rol de servicio, como en 007: no hay políticas INSERT/UPDATE. ⚠️ No está
-- medido si el dueño de las tablas en Cloud SQL esquiva `FORCE ROW LEVEL SECURITY` (no es
-- superusuario real). Medirlo antes del paso 3 del ADR (autoría desde el portal): si no lo esquiva,
-- la autoría necesitará una política de escritura para su rol, y ese rol aún no existe.
--
-- Idempotente: IF NOT EXISTS, DROP POLICY IF EXISTS + CREATE POLICY, y guardas en pg_constraint /
-- pg_trigger. Probada dos veces seguidas contra Postgres 16 + pgvector 0.8.4 local el 2026-10-08.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS casos_exito (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id         UUID NOT NULL,          -- partners.id del plano de control (otra base: sin FK)
    slug               TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
    estado             TEXT NOT NULL DEFAULT 'borrador'
                       CHECK (estado IN ('borrador', 'en_revision', 'publicado', 'retirado')),
    frontmatter        JSONB NOT NULL CHECK (jsonb_typeof(frontmatter) = 'object'),
    cuerpo_md          TEXT NOT NULL,
    nota_consultor_md  TEXT NOT NULL DEFAULT '',   -- interna: nunca se envía al lead (D-224.1)
    version_publicada  INT,
    sector             TEXT GENERATED ALWAYS AS (frontmatter ->> 'sector') STORED,
    tamano             TEXT GENERATED ALWAYS AS (frontmatter ->> 'tamano') STORED,
    embedding_dolor    vector(768),              -- del `dolor_canonico`; mismo modelo que el corpus
    fts                tsvector GENERATED ALWAYS AS (
                           to_tsvector('spanish',
                               coalesce(frontmatter ->> 'titulo', '') || ' ' ||
                               coalesce(frontmatter ->> 'dolor_canonico', '') || ' ' ||
                               cuerpo_md)
                       ) STORED,
    revisado_por       TEXT,                     -- uid de Identity Platform del curador de micontexto
    revisado_at        TIMESTAMPTZ,
    motivo_devolucion  TEXT,                     -- por qué la curaduría lo devolvió a borrador
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (partner_id, slug),
    CONSTRAINT casos_exito_publicado_completo CHECK (
        estado <> 'publicado'
        OR (version_publicada IS NOT NULL AND embedding_dolor IS NOT NULL
            AND revisado_por IS NOT NULL AND revisado_at IS NOT NULL)
    ),
    CONSTRAINT casos_exito_revision_con_nota CHECK (
        estado NOT IN ('en_revision', 'publicado') OR length(btrim(nota_consultor_md)) >= 40
    )
);

COMMENT ON TABLE casos_exito IS
    'ADR-224: casos de éxito escritos por aliados proveedores. Sólo estado=publicado llega a un lead. Encabezado validado por CasoFrontmatterSchema (contracts/src/casos.ts).';
COMMENT ON COLUMN casos_exito.nota_consultor_md IS
    'Nota del consultor (D-224.1): dolores que cubre, objeciones, servicios ligados. Uso interno; nunca se envía al lead.';

CREATE TABLE IF NOT EXISTS casos_exito_versiones (
    caso_id            UUID NOT NULL REFERENCES casos_exito(id) ON DELETE RESTRICT,
    version            INT NOT NULL CHECK (version >= 1),
    frontmatter        JSONB NOT NULL CHECK (jsonb_typeof(frontmatter) = 'object'),
    cuerpo_md          TEXT NOT NULL,
    nota_consultor_md  TEXT NOT NULL,
    content_sha256     TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    publicado_por      TEXT NOT NULL,            -- uid del curador que aprobó esta versión
    publicado_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (caso_id, version)
);

COMMENT ON TABLE casos_exito_versiones IS
    'ADR-224: una fila inmutable por publicación. Prueba qué versión vio el lead; partner_lead_referrals (control) la referencia por (case_id, case_version).';

-- La versión vigente tiene que existir como snapshot. MATCH SIMPLE: mientras version_publicada sea
-- NULL (borrador nunca publicado) no se comprueba.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'casos_exito_version_publicada_fk') THEN
        ALTER TABLE casos_exito
            ADD CONSTRAINT casos_exito_version_publicada_fk
            FOREIGN KEY (id, version_publicada)
            REFERENCES casos_exito_versiones (caso_id, version) ON DELETE RESTRICT;
    END IF;
END $$;

-- Una versión publicada no se reescribe: si hay que corregir algo, se publica la siguiente.
CREATE OR REPLACE FUNCTION casos_exito_versiones_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'casos_exito_versiones es inmutable: publica una versión nueva en lugar de editar la % del caso %',
        OLD.version, OLD.caso_id
        USING ERRCODE = 'restrict_violation';
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'casos_exito_versiones_sin_update') THEN
        CREATE TRIGGER casos_exito_versiones_sin_update
            BEFORE UPDATE ON casos_exito_versiones
            FOR EACH ROW EXECUTE FUNCTION casos_exito_versiones_inmutable();
    END IF;
END $$;

-- Índices del paso 1 (filtro duro) y del paso 2 (recuperación híbrida) de D-224.4.
CREATE INDEX IF NOT EXISTS casos_exito_embedding_idx
    ON casos_exito USING hnsw (embedding_dolor vector_cosine_ops)
    WHERE estado = 'publicado';
CREATE INDEX IF NOT EXISTS casos_exito_fts_idx ON casos_exito USING gin (fts);
CREATE INDEX IF NOT EXISTS casos_exito_frontmatter_idx ON casos_exito USING gin (frontmatter);
CREATE INDEX IF NOT EXISTS casos_exito_filtro_idx ON casos_exito (estado, sector, tamano);
CREATE INDEX IF NOT EXISTS casos_exito_partner_idx ON casos_exito (partner_id, estado);

-- RLS: ENABLE + FORCE, mismo patrón que 004 y 007.
ALTER TABLE casos_exito ENABLE ROW LEVEL SECURITY;
ALTER TABLE casos_exito FORCE ROW LEVEL SECURITY;
ALTER TABLE casos_exito_versiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE casos_exito_versiones FORCE ROW LEVEL SECURITY;

-- El aliado ve todos sus casos, en cualquier estado (portal).
DROP POLICY IF EXISTS casos_partner_read ON casos_exito;
CREATE POLICY casos_partner_read ON casos_exito FOR SELECT USING (
    partner_id::text = current_setting('app.partner_id', true)
);

-- Un tenant ve sólo los publicados. Un caso publicado ya pasó curaduría y tiene permiso del
-- cliente: es material para distribuir, así que no se ata a una licencia por tenant como el
-- conocimiento de 007. El filtro por contrato de referidos vigente lo hace la aplicación con los
-- partner_id que lee del plano de control (paso 1 de D-224.4).
DROP POLICY IF EXISTS casos_publicados_read ON casos_exito;
CREATE POLICY casos_publicados_read ON casos_exito FOR SELECT USING (
    estado = 'publicado' AND coalesce(current_setting('app.tenant_id', true), '') <> ''
);

DROP POLICY IF EXISTS casos_versiones_partner_read ON casos_exito_versiones;
CREATE POLICY casos_versiones_partner_read ON casos_exito_versiones FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM casos_exito c
        WHERE c.id = casos_exito_versiones.caso_id
          AND c.partner_id::text = current_setting('app.partner_id', true)
    )
);

DROP POLICY IF EXISTS casos_versiones_publicadas_read ON casos_exito_versiones;
CREATE POLICY casos_versiones_publicadas_read ON casos_exito_versiones FOR SELECT USING (
    coalesce(current_setting('app.tenant_id', true), '') <> ''
    AND EXISTS (
        SELECT 1 FROM casos_exito c
        WHERE c.id = casos_exito_versiones.caso_id AND c.estado = 'publicado'
    )
);

-- Lectura para la credencial compartida del orquestador. Condicionado a que el rol exista: en
-- dev/CI no hay `kdb_reader` y un GRANT a un rol inexistente aborta la transacción (mismo
-- patrón que la 011 con app_rw).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kdb_reader') THEN
        GRANT SELECT ON casos_exito, casos_exito_versiones TO kdb_reader;
    END IF;
END $$;

COMMIT;
