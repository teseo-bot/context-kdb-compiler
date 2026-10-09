-- 017_casos_exito_versiones_revoke.sql — kdb_compiler deja de poder reescribir o borrar una versión publicada (ADR-224)
--
-- QUÉ PASÓ. La 016 le da a `kdb_compiler` sólo SELECT e INSERT sobre `casos_exito_versiones`: una
-- versión publicada es la evidencia de un fee y el servicio no debe tener con qué tocarla. Medido
-- el 2026-10-09 en producción, después de aplicarla: `kdb_compiler` tenía además UPDATE y DELETE.
-- La causa son los privilegios por defecto del Cold-Tier:
--
--     pg_default_acl → postgres → kdb_compiler=arwd/postgres
--
-- Toda tabla que crea `postgres` en el Cold-Tier le da automáticamente SELECT, INSERT, UPDATE y
-- DELETE a `kdb_compiler` (no le da TRUNCATE, medido: f). Un GRANT de la migración sólo SUMA
-- permisos: no quita los que ya llegaron por defecto. En local no se vio porque el Postgres de
-- pruebas no tiene esos privilegios por defecto.
--
-- QUÉ CAMBIA. Se le quitan a `kdb_compiler` UPDATE y DELETE (y TRUNCATE por si un día se añade
-- a los privilegios por defecto) sobre `casos_exito_versiones`. Sobre `casos_exito` se queda con
-- los cuatro, que es lo que la autoría necesita. El trigger de la 016 ya impedía reescribir una
-- versión; esto cierra también el borrado de versiones no vigentes, que la FK no cubre.
--
-- LECCIÓN PARA LA PRÓXIMA TABLA DEL COLD-TIER: lo que una tabla nueva NO debe permitirle a
-- `kdb_compiler` se tiene que revocar explícitamente en la misma migración.
--
-- APLICAR COMO `postgres` (es el que concedió esos permisos: sólo él puede revocarlos). Idempotente:
-- REVOKE de un permiso que no se tiene no falla.

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kdb_compiler') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON casos_exito_versiones FROM kdb_compiler;
    END IF;
END $$;

COMMIT;
