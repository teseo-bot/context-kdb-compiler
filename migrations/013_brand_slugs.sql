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
-- Idempotente: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Depende de: 009_kdb_schema.sql (crea kdb.documents, kdb.chunks, kdb.okf_concepts).

BEGIN;

-- ─── Plano PRIVADO del tenant (schema kdb) — el que sirve al corpus con usuario real ───────
ALTER TABLE kdb.documents    ADD COLUMN IF NOT EXISTS brand_slugs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE kdb.chunks       ADD COLUMN IF NOT EXISTS brand_slugs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE kdb.okf_concepts ADD COLUMN IF NOT EXISTS brand_slugs TEXT[] NOT NULL DEFAULT '{}';

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
CREATE INDEX IF NOT EXISTS kdb_chunks_brand_slugs_idx
    ON kdb.chunks USING gin (brand_slugs);
CREATE INDEX IF NOT EXISTS kdb_okf_concepts_brand_slugs_idx
    ON kdb.okf_concepts USING gin (brand_slugs);

-- ─── Contrapartes en `public` ──────────────────────────────────────────────────────────────
-- Son las tablas legado previas al corte de los dos planos. Se añaden por una razón concreta,
-- no por simetría: `searchChunks` (orquestador) hace `SET search_path = kdb, public` SÓLO
-- cuando recibe tenantId. Si algún camino resolviera `FROM chunks` contra `public`, la
-- consulta de WU-4.2 fallaría con 42703 — y como ese call site tiene `catch`, se presentaría
-- como AUSENCIA DE DATOS, no como error. Ese modo de fallo silencioso es exactamente el que
-- este ADR intenta cerrar, así que la columna existe en las dos.
ALTER TABLE public.documents    ADD COLUMN IF NOT EXISTS brand_slugs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.chunks       ADD COLUMN IF NOT EXISTS brand_slugs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.okf_concepts ADD COLUMN IF NOT EXISTS brand_slugs TEXT[] NOT NULL DEFAULT '{}';

COMMIT;
