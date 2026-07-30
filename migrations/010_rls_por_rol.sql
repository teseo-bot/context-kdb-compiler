-- 010_rls_por_rol.sql — RLS ligado a la identidad de conexión (ADR-210 D-210.7)
--
-- PROBLEMA QUE PREPARA RESOLVER. Hoy la frontera de aislamiento es "la aplicación
-- calcula bien el tenant": `kdb_reader` es UNA credencial compartida por todos los
-- tenants, y la política compara contra `current_setting('app.tenant_id')`, una
-- variable de sesión que CUALQUIERA con esa credencial puede fijar a cualquier valor.
-- Una inyección que alcance un `SET`, o un code path que resuelva mal el tenant, cruza
-- el aislamiento entero. Peor: con un rol BYPASSRLS falla ABIERTO (fuga silenciosa),
-- no cerrado.
--
-- A DÓNDE VAMOS. La política se liga a la IDENTIDAD DE LA CONEXIÓN, no a un GUC
-- seteable:
--     antes:  USING (tenant_id = current_setting('app.tenant_id', true))
--     meta:   USING (tenant_id = kdb.tenant_of_role(current_user))
-- Con eso, un servicio comprometido que tenga la credencial de A no puede leer B sin
-- obtener OTRO secreto y OTRO grant de IAM. La frontera pasa de "disciplina de la
-- aplicación" a "posesión de credencial".
--
-- ⚠️⚠️ RESTRICCIÓN CRÍTICA DE SEGURIDAD ⚠️⚠️
-- Esta migración NO crea, NO altera y NO borra NINGUNA política RLS, y no toca
-- ENABLE/FORCE ROW LEVEL SECURITY en ninguna tabla. Motivo: varias políticas
-- permisivas sobre la misma tabla se combinan con OR, así que añadir la política nueva
-- junto a la vieja DEBILITARÍA el aislamiento en vez de reforzarlo.
--
-- El intercambio de políticas es una migración POSTERIOR y GATEADA (011+), que exige
-- que las credenciales por tenant ya existan y estén cableadas en los servicios —
-- trabajo de `gcloud` del CEO. Hasta entonces, esto solo instala la infraestructura.
--
-- TIPO DE `tenant_id`: TEXT, no uuid. Confirmado en 002_add_tenant_id.sql:2,3,19 y en
-- 003_okf_index.sql. (ADR-208 tenía TEXT como destino; en el Cold-Tier ya lo es.)

-- ⚠️ TODO OBJETO VA CUALIFICADO CON `kdb.`. Sin cualificar, el schema lo decide el
-- search_path de quien aplica la migración: en `micontexto-tenant1:hot-tier` (search_path
-- `"$user", public`) los dos objetos aterrizaron en `public`, no en `kdb`, contradiciendo
-- la meta que esta misma cabecera declara — `kdb.tenant_of_role(current_user)`. El
-- criterio de verificación (6 tablas / 18 índices en `kdb`) no lo detecta porque solo
-- cuenta lo de 009. Detectado y corregido 2026-07-29.
CREATE TABLE IF NOT EXISTS kdb.role_tenant_map (
  role_name  TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE kdb.role_tenant_map IS
  'Mapa credencial->tenant. Fuente de verdad del aislamiento cuando la migracion 011 ligue las politicas a current_user (ADR-210 D-210.7). Una fila por credencial kdb_reader_t{N}.';

CREATE OR REPLACE FUNCTION kdb.tenant_of_role(p_role TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT tenant_id FROM kdb.role_tenant_map WHERE role_name = p_role $$;

-- SECURITY DEFINER con search_path FIJO: la función debe poder leer role_tenant_map
-- aunque el rol que la invoca no tenga permiso directo sobre la tabla — si no, cada
-- credencial de tenant necesitaría SELECT sobre el mapa completo, que es justo lo que
-- no queremos. El search_path fijo evita el secuestro por schema (CVE clásico de
-- SECURITY DEFINER: un schema temporal con una tabla homónima). `public` sale del
-- search_path fijo porque la referencia a la tabla ya va cualificada: cuanto más corto
-- el path, menos superficie de secuestro.
REVOKE ALL ON FUNCTION kdb.tenant_of_role(TEXT) FROM PUBLIC;

COMMENT ON FUNCTION kdb.tenant_of_role(TEXT) IS
  'Devuelve el tenant de una credencial. SECURITY DEFINER + search_path fijo: lee role_tenant_map sin exponerla al rol invocante y sin riesgo de secuestro por schema.';
