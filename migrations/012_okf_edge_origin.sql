-- 012_okf_edge_origin.sql — confianza explícita en la arista OKF: EXTRACTED vs INFERRED
--
-- ADR-210 D-210.13 dio esta marca por adoptada el 2026-07-24. Medido el 2026-08-03: no
-- existía en ningún repo. Esta migración la crea.
--
-- POR QUÉ VA AHORA, ANTES DE ENCENDER EL DESTILADOR — la condición de tiempo es el punto
-- entero de la tarea. Una arista producida por el destilador LLM es una INFERENCIA. En
-- cuanto el destilador escriba la primera arista sin marca, separarlas a posteriori es
-- imposible sin re-destilar el corpus: el artefacto no conserva ningún rastro de quién puso
-- el enlace. Hoy las dos tablas están VACÍAS (medido en micontexto-coldtier:context-kdb-db,
-- 2026-08-02) y `night-worker` nunca se desplegó, así que esto es DDL puro sobre cero filas.
-- Ese es el estado más barato en el que esta columna puede llegar a existir, y no se repite.
--
-- QUÉ COMPRA: el programa de aliados (ADR-203) vende conocimiento CERTIFICADO. Un concepto
-- certificado cuyas aristas son inferencias de LLM presentadas como extracciones de la
-- fuente es exactamente el pasivo que el sello de curaduría (PA5-W5) y el gate de eval
-- (PA7-W2) existen para evitar.
--
-- ALCANCE: las dos tablas de aristas, en los dos planos.
--   · okf_edges          plano privado del tenant (kdb.okf_edges tras 009; public.okf_edges
--                        en la forma legada de 003). Se cubren AMBOS esquemas: qué instancia
--                        tiene cuál depende de si ya corrió 009, y esta migración se aplica
--                        en las dos.
--   · okf_partner_edges  plano de aliados, Cold-Tier compartido (007). Es el que sostiene
--                        la promesa de "certificado", así que quedarse sin marcar habría
--                        dejado sin cubrir justo el caso que motiva la columna.
--
-- POR QUÉ 'INFERRED' COMO DEFAULT DEL BACKFILL, Y POR QUÉ SE RETIRA DESPUÉS:
--   · EXTRACTED es la marca que SOBRE-AFIRMA. Una fila preexistente sin marca no puede
--     ascender a "estaba explícita en la fuente" por el hecho de ser vieja. Con cero filas
--     el backfill no toca nada, pero la elección tiene que ser correcta igualmente: si la
--     medición se equivocó y hay filas, quedan del lado conservador.
--   · Y luego se hace DROP DEFAULT, siguiendo la regla de la casa que 011 dejó escrita para
--     `tenant_id`: un INSERT que olvide la columna debe fallar en seco, no aterrizar en un
--     valor plausible e invisible. El default sólo existe para la duración del backfill.
--
-- Se aplica en la instancia DEL TENANT (micontexto-tenant{N}:hot-tier) para okf_edges y en
-- el Cold-Tier (micontexto-coldtier:context-kdb-db) para okf_partner_edges. Es idempotente y
-- salta en silencio la tabla que no exista en la instancia donde se corra.
--
-- APLICAR CON `app_rw`, no con `postgres` — mismo motivo que 009/011.

DO $origin$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname IN ('public', 'kdb')
          AND c.relname IN ('okf_edges', 'okf_partner_edges')
    LOOP
        -- ADD COLUMN IF NOT EXISTS + DEFAULT: rellena las filas existentes (hoy, ninguna)
        -- con la marca conservadora.
        EXECUTE format(
            'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT ''INFERRED''',
            target.schema_name, target.table_name
        );

        -- El CHECK va aparte de la columna para poder nombrarlo e IF NOT EXISTS-earlo: sin
        -- nombre, reaplicar la migración acumularía restricciones anónimas duplicadas.
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = target.table_name || '_origin_check'
              AND conrelid = format('%I.%I', target.schema_name, target.table_name)::regclass
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (origin IN (''EXTRACTED'', ''INFERRED''))',
                target.schema_name, target.table_name, target.table_name || '_origin_check'
            );
        END IF;

        -- Retirado el default: a partir de aquí, insertar una arista sin declarar su origen
        -- es un error, no una suposición.
        EXECUTE format(
            'ALTER TABLE %I.%I ALTER COLUMN origin DROP DEFAULT',
            target.schema_name, target.table_name
        );

        RAISE NOTICE 'okf edge origin: % .% marcada', target.schema_name, target.table_name;
    END LOOP;
END
$origin$;

-- ── Verificación ────────────────────────────────────────────────────────────────
--
-- Que la columna existe, es NOT NULL y NO tiene default (las tres cosas, no sólo la primera):
--
--   SELECT table_schema, table_name, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE column_name = 'origin'
--      AND table_name IN ('okf_edges', 'okf_partner_edges');
--
-- Esperado: is_nullable = 'NO' y column_default = NULL en cada fila.
--
-- Y que el seco es seco de verdad — esto DEBE fallar con "null value in column origin":
--
--   INSERT INTO okf_edges (tenant_id, from_path, to_path) VALUES ('x', 'a.md', 'b.md');
