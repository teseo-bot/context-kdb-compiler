-- Reversión de 010_rls_por_rol.sql (ADR-210 D-210.7).
-- Seguro de correr: 010 no tocó ninguna política, así que revertirlo no puede
-- reabrir un aislamiento. Solo retira la infraestructura que aún no se usa.
--
-- Se cualifica con `kdb.` igual que la migración de ida. Las dos líneas de `public`
-- limpian el aterrizaje equivocado de quien aplicó la versión anterior de 010, que no
-- cualificaba (micontexto-tenant1 el 2026-07-29, micontexto-tenant2-503516 el
-- 2026-07-25); son no-op donde los objetos nunca existieron.
DROP FUNCTION IF EXISTS kdb.tenant_of_role(TEXT);
DROP TABLE IF EXISTS kdb.role_tenant_map;

DROP FUNCTION IF EXISTS public.tenant_of_role(TEXT);
DROP TABLE IF EXISTS public.role_tenant_map;
