-- 013_brand_slugs.sql — el eje de MARCA sobre el corpus del tenant (ADR-215 WU-4.1)
--
-- Fleetco y Cargalo atacan el mismo mercado con el mismo equipo comercial (ADR-215). Sin un
-- eje de marca en la recuperación, un agente de Fleetco puede citar contenido de Cargalo y al
-- revés: no es un detalle estético, es decirle al prospecto el producto equivocado con la voz
-- del otro.
--
-- POR QUÉ AHORA, ANTES DE CARGAR EL CORPUS — misma condición de tiempo que la 012 con
-- `origin`, y por la misma razón. Hoy `kdb.documents` está en cero: el primer documento real
-- todavía no se ha cargado. Etiquetar a posteriori exigiría revisar documento por documento
-- para decidir de qué marca es cada uno. Este es el estado más barato en el que esta columna
-- puede existir, y no se repite.
--
-- ⚠️ EL DEFAULT ES LO IMPORTANTE, NO LA COLUMNA. `'{}'` = array vacío = **compartido, visible
-- para TODAS las marcas** ([INV-215.5]). Toda fila existente o futura sin etiqueta queda
-- compartida, sin backfill. La exclusividad es opt-in.
--
-- Si el default fuera al revés —etiquetar todo por producto— se reconstruiría el problema de
-- los dos corpus con pasos extra, y se ANULARÍA el retargeting: la gracia del modelo es que
-- Cargalo herede lo que Fleetco aprendió. En este negocio la mayoría del corpus (mercado,
-- sector, dolores, objeciones) es compartido; sólo lo específico de producto se marca.
--
-- ⛔ NO se tocan `okf_partner_concepts` ni `okf_partner_edges`: el plano de aliados es AJENO a
-- la marca del tenant (ADR-215 §5). Un PCC se compila 1× y se licencia por referencia.
--
-- ⛔ NO se codifica la marca en `system_slug` ni en `altitude` ([INV-215.4]): son los ejes de
-- la taxonomía HOCFLIT. La marca es un eje nuevo y ortogonal, con su propia columna. Conflar
-- ejes ya costó una corrección en este programa.
--
-- Sobre el aviso «aplicar con app_rw, no con postgres»: NO aplica aquí. Nació de un
-- CREATE TABLE en la 009 —la tabla nueva quedaba de `postgres` y el servicio no la veía—.
-- `ALTER TABLE ... ADD COLUMN` no transfiere la propiedad ni toca los GRANT existentes.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, y además GUARDADA por
-- catálogo — ver abajo por qué hizo falta.
-- Depende de: 009_kdb_schema.sql (crea kdb.documents, kdb.chunks, kdb.okf_concepts).
--
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- 🔴 POR QUÉ ESTA MIGRACIÓN NO CORRÍA EN NINGÚN SITIO — medido el 2026-08-19
--
-- La versión plana de este archivo (seis `ALTER TABLE` sin guarda, tres en `kdb.*` y tres en
-- `public.*`) es INAPLICABLE en los dos planos que existen, porque NINGUNO tiene las seis
-- tablas. Medido con `to_regclass`, no con `information_schema`:
--
--     plano                             kdb.documents   public.okf_concepts
--     hot-tier del tenant (t1 y t2)     ✅ existe        ❌ NO existe
--     Cold-Tier compartido              ❌ NO existe     ✅ existe
--
-- ⇒ en un hot-tier reventaba en `ALTER TABLE public.okf_concepts` («relation does not
--   exist»); en el Cold-Tier habría reventado antes, en `ALTER TABLE kdb.documents`.
--
-- Y como cualquier error aborta la transacción entera, no dejaba nada aplicado en ninguno de
-- los dos. Verificado el 2026-08-19 contra `pg_attribute` (privilege-independent, que es lo
-- que `information_schema` no es): `brand_slugs` no existía NI en el hot-tier de tenant1 NI
-- en el Cold-Tier. Cero filas, los dos planos.
--
-- EL MODO DE FALLO ERA CARO, NO RUIDOSO. `main` del compiler hace
-- `INSERT INTO documents (..., brand_slugs)` sin guarda (`src/core/compiler-engine.ts`), así
-- que el compiler COMPARTIDO —que despliega desde `main` en cada push— tiene su `/v1/ingest`
-- roto por construcción, y el de tenant1 sólo se salva porque su imagen está clavada en un
-- SHA anterior a WU-4.4: cualquier redespliegue suyo lo rompe también. Una migración que no
-- se puede aplicar no avisa; el código que la presupone, tampoco, hasta que alguien ingiere.
--
-- ARREGLO: la misma forma que ya usa la 012 — un bucle sobre el CATÁLOGO que altera lo que
-- existe y salta en silencio lo que no. Un solo archivo canónico, correcto en los dos planos,
-- en vez de dos variantes por entorno que se desincronizan. No se relaja ninguna garantía: la
-- tabla que existe se altera exactamente igual, con el mismo tipo, el mismo NOT NULL y el
-- mismo DEFAULT `'{}'`.
-- ══════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── La columna, donde exista la tabla ─────────────────────────────────────────────────────
--
-- `kdb.*` es el plano PRIVADO del tenant, el que sirve al corpus con usuario real.
-- `public.*` son las tablas legado previas al corte de los dos planos, y NO se incluyen por
-- simetría: `searchChunks` (orquestador) hace `SET search_path = kdb, public` SÓLO cuando
-- recibe tenantId, así que un camino que resolviera `FROM chunks` contra `public` fallaría con
-- 42703 — y como ese call site tiene `catch`, se presentaría como AUSENCIA DE DATOS, no como
-- error. Ese modo de fallo silencioso es el que este ADR existe para cerrar.
DO $marca$
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
            'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS brand_slugs TEXT[] NOT NULL DEFAULT ''{}''',
            objetivo.esquema, objetivo.tabla
        );
        RAISE NOTICE 'brand_slugs: %.% marcada', objetivo.esquema, objetivo.tabla;
    END LOOP;
END
$marca$;

-- ─── Los índices GIN ───────────────────────────────────────────────────────────────────────
--
-- 🔴 LA FORMA DEL PREDICADO NO ES LIBRE — medido con EXPLAIN sobre 20 000 filas:
--
--     'fleetco' = ANY(brand_slugs)        → Seq Scan. GIN NO lo puede usar.
--     brand_slugs @> ARRAY['fleetco']     → Bitmap Index Scan ✅
--     brand_slugs && ARRAY['fleetco']     → Bitmap Index Scan ✅
--
-- El operador `= ANY` no está en la clase de operadores `array_ops` de GIN, que sólo cubre
-- `@>`, `&&` y `<@`. Quien escriba WU-4.2/4.3 debe usar `&&`, no `= ANY` — con `= ANY` el
-- índice existe, se mantiene en cada escritura y NUNCA se usa.
--
-- Y una precisión que evita una "optimización" equivocada más adelante: en la consulta REAL
-- de `searchChunks` el índice que manda es el HNSW, no éste. Verificado con EXPLAIN: el plan
-- es `Index Scan using …_hnsw` con la marca aplicada como FILTRO durante el recorrido; el
-- `SET hnsw.iterative_scan = relaxed_order` que ya está en el código es lo que hace que siga
-- escaneando hasta juntar `limit` filas que pasen el filtro, en vez de cortar antes.
-- Este GIN sirve al camino FTS del OKF y a las consultas analíticas, no al vectorial.
--
-- Sólo sobre `kdb.*`: las de `public` son legado en vía de retiro y no las recorre ninguna
-- consulta de marca — un índice ahí sería coste de escritura sin lector.
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
            'CREATE INDEX IF NOT EXISTS %I ON kdb.%I USING gin (brand_slugs)',
            'kdb_' || objetivo.tabla || '_brand_slugs_idx', objetivo.tabla
        );
    END LOOP;
END
$indices$;

COMMIT;

-- ── Verificación ───────────────────────────────────────────────────────────────────────────
--
-- Contra el catálogo, NO contra `information_schema` (que filtra por privilegios y ya mintió
-- una vez en este mismo frente, en el hot-tier de tenant2):
--
--   SELECT n.nspname, c.relname
--     FROM pg_attribute a
--     JOIN pg_class c ON c.oid = a.attrelid
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE a.attname = 'brand_slugs' AND NOT a.attisdropped
--    ORDER BY 1, 2;
--
-- Esperado en un hot-tier de tenant: kdb.chunks, kdb.documents, kdb.okf_concepts,
-- public.chunks, public.documents  (cinco — `public.okf_concepts` no existe ahí).
-- Esperado en el Cold-Tier: public.chunks, public.documents, public.okf_concepts.
