-- Reversión de 010_rls_por_rol.sql (ADR-210 D-210.7).
-- Seguro de correr: 010 no tocó ninguna política, así que revertirlo no puede
-- reabrir un aislamiento. Solo retira la infraestructura que aún no se usa.
DROP FUNCTION IF EXISTS tenant_of_role(TEXT);
DROP TABLE IF EXISTS role_tenant_map;
