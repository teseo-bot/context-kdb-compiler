-- 014_project_slugs.sql — el eje de PROYECTO sobre el corpus del tenant (ADR-220 D-220.1)
--
-- El tenant del entrevistador atiende a VARIOS clientes a la vez. Sin un eje de proyecto en
-- la recuperación, el agente que entrevista para un cliente puede citar el material que
-- aportó otro: no es un detalle de relevancia como en la marca, es una fuga de
-- confidencialidad entre clientes que compiten.
--
-- ⛔ POR QUÉ COLUMNA PROPIA Y NO REUTILIZAR `brand_slugs` — D-220.1, decidido y aprobado.
-- Reutilizarla era más barato: el índice, el operador y los seis filtros ya están. Se
-- descarta porque la columna significaría «marca» en un tenant y «proyecto» en otro, así que
-- el predicado correcto dependería del tenant — la clase de condición que se olvida en la
-- sexta lectura, y cuyo modo de fallo es ver conocimiento DE MÁS, en silencio. Y un tenant
-- que mañana necesite los dos ejes obligaría a deshacerlo con datos dentro.
--
-- ⚠️ EL DEFAULT `'{}'` NO ES UN DESCUIDO, Y NO ES EL DE LA UI. Aquí `'{}'` significa «base
-- del tenant»: metodología, guías de tono, políticas — lo ve cualquier agente del tenant.
-- Es el MISMO predicado que la marca, y tiene que serlo: la alternativa —que el vacío no lo
-- vea nadie— dejaría inaccesible todo lo cargado antes de que existieran los proyectos.
--
-- La inversión que pide D-220.2 vive en el PANEL, no aquí: el proyecto va preseleccionado y
-- «base del tenant» hay que elegirlo a mano. Quien venga a «arreglar» este default estaría
-- deshaciendo esa decisión en el sitio equivocado.
--
-- ⛔ NO se tocan `okf_partner_concepts` ni `okf_partner_edges`: el plano de aliados es AJENO
-- a los ejes del tenant, igual que en ADR-215 §5.
--
-- ⛔ NO se codifica el proyecto en `system_slug`, `altitude` ni `brand_slugs`: son ejes
-- distintos. Conflar ejes ya costó una corrección en este programa.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, y GUARDADA POR
-- CATÁLOGO por la razón que documenta la 013 y que conviene no volver a aprender:
--
--     plano                             kdb.documents   public.okf_concepts
--     hot-tier del tenant (t1 y t2)     ✅ existe        ❌ NO existe
--     Cold-Tier compartido              ❌ NO existe     ✅ existe
--
-- Seis `ALTER TABLE` planos son INAPLICABLES en los dos planos, porque ninguno tiene las
-- seis tablas, y como cualquier error aborta la transacción entera no dejan nada aplicado.
-- El bucle sobre `pg_class` altera lo que existe y salta en silencio lo que no.
--
-- Depende de: 009_kdb_schema.sql. Aplicar DESPUÉS de la 013.

BEGIN;

-- ─── La columna, donde exista la tabla ─────────────────────────────────────────────────────
DO $proyecto$
DECLARE
    objetivo RECORD;
BEGIN
    FOR objetivo IN
        SELECT n.nspname AS esquema, c.relname AS tabla
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname IN ('public', 'kdb')
          AND c.relname IN ('documents', 'chunks', 'okf_concepts')
        ORDER BY 1, 2
    LOOP
        EXECUTE format(
            'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS project_slugs TEXT[] NOT NULL DEFAULT ''{}''',
            objetivo.esquema, objetivo.tabla
        );
        RAISE NOTICE 'project_slugs: %.% marcada', objetivo.esquema, objetivo.tabla;
    END LOOP;
END
$proyecto$;

-- ─── Los índices GIN ───────────────────────────────────────────────────────────────────────
--
-- 🔴 LA FORMA DEL PREDICADO NO ES LIBRE, y es la misma lección que dejó la 013:
--
--     'acme' = ANY(project_slugs)        → Seq Scan. GIN NO lo puede usar.
--     project_slugs @> ARRAY['acme']     → Bitmap Index Scan ✅
--
-- `= ANY` no está en la clase de operadores `array_ops` de GIN, que sólo cubre `@>`, `&&` y
-- `<@`. Con `= ANY` el índice existe, se mantiene en cada escritura y NUNCA se usa.
--
-- Sólo sobre `kdb.*`: las de `public` son legado en vía de retiro y ninguna consulta de
-- alcance las recorre — un índice ahí sería coste de escritura sin lector.
DO $indices$
DECLARE
    objetivo RECORD;
BEGIN
    FOR objetivo IN
        SELECT c.relname AS tabla
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname = 'kdb'
          AND c.relname IN ('chunks', 'okf_concepts')
        ORDER BY 1
    LOOP
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON kdb.%I USING gin (project_slugs)',
            'kdb_' || objetivo.tabla || '_project_slugs_idx', objetivo.tabla
        );
        RAISE NOTICE 'project_slugs: índice GIN sobre kdb.%', objetivo.tabla;
    END LOOP;
END
$indices$;

COMMIT;
