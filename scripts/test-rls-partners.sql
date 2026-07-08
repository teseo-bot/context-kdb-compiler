-- Test de RLS para el índice Cold-Tier de aliados (migración 007)
-- Paso a paso comentado, espejo de scripts/test-rls.sql
-- Ejecución: psql -U postgres -h localhost -p 5436 -d postgres -f scripts/test-rls-partners.sql
--
-- Mecánica: el seed se inserta como rol de servicio (postgres, superuser: exento de RLS);
-- los SELECT de verificación se hacen con SET ROLE app_user (no-superuser: RLS aplica).
-- Todo dentro de una transacción que se REVIERTE al final.
-- Requiere que exista el rol app_user con GRANT SELECT sobre las 3 tablas
-- (el runner scripts/test-rls-partners.ts lo crea automáticamente).

BEGIN;

-- === SETUP (rol de servicio): conceptos de partner 1 ===
-- doc1: finanzas / altitude 2 · doc2: comercial / altitude 3 · doc3: operaciones / altitude 1
INSERT INTO okf_partner_concepts (
    id, partner_id, package_id, version, path, gcs_path, frontmatter, body_text,
    content_sha256, altitude, system_slug
) VALUES
    ('d1111111-1111-1111-1111-111111111111'::uuid,
     'a1111111-1111-1111-1111-111111111111'::uuid,
     'b1111111-1111-1111-1111-111111111111'::uuid,
     1, 'doc1.md', 'gs://bucket/doc1.md', '{"title":"Doc 1"}', 'Content for doc 1',
     'hash1', 2, 'finanzas'),
    ('d1111111-1111-1111-1111-111111111112'::uuid,
     'a1111111-1111-1111-1111-111111111111'::uuid,
     'b1111111-1111-1111-1111-111111111111'::uuid,
     1, 'doc2.md', 'gs://bucket/doc2.md', '{"title":"Doc 2"}', 'Content for doc 2',
     'hash2', 3, 'comercial'),
    ('d1111111-1111-1111-1111-111111111113'::uuid,
     'a1111111-1111-1111-1111-111111111111'::uuid,
     'b1111111-1111-1111-1111-111111111111'::uuid,
     1, 'doc3.md', 'gs://bucket/doc3.md', '{"title":"Doc 3"}', 'Content for doc 3',
     'hash3', 1, 'operaciones');

-- === SETUP (rol de servicio): concepto de partner 2 ===
INSERT INTO okf_partner_concepts (
    id, partner_id, package_id, version, path, gcs_path, frontmatter, body_text,
    content_sha256, altitude, system_slug
) VALUES
    ('d2222222-2222-2222-2222-222222222222'::uuid,
     'a2222222-2222-2222-2222-222222222222'::uuid,
     'b2222222-2222-2222-2222-222222222222'::uuid,
     1, 'other.md', 'gs://bucket/other.md', '{"title":"Other"}', 'Content from partner 2',
     'hash_other', 2, 'finanzas');

-- === SETUP (rol de servicio): licencias ===
-- c1: t1, activa y vigente, systems=[finanzas,comercial], altitude_max=3
-- c2: t3, status='active' pero valid_until en el PASADO (caso 2: expira por tiempo, sin tocar status)
INSERT INTO kdb_partner_licenses (
    contract_id, tenant_id, partner_id, package_id, version,
    systems, altitude_max, modules, valid_from, valid_until, status
) VALUES
    ('c1111111-1111-1111-1111-111111111111'::uuid, 't1',
     'a1111111-1111-1111-1111-111111111111'::uuid,
     'b1111111-1111-1111-1111-111111111111'::uuid, 1,
     ARRAY['finanzas','comercial'], 3, ARRAY['read','search'],
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', 'active'),
    ('c2222222-2222-2222-2222-222222222222'::uuid, 't3',
     'a1111111-1111-1111-1111-111111111111'::uuid,
     'b1111111-1111-1111-1111-111111111111'::uuid, 1,
     ARRAY['finanzas','comercial'], 3, ARRAY['read','search'],
     NOW() - INTERVAL '60 days', NOW() - INTERVAL '30 days', 'active');

-- Cambiar al rol de aplicación: a partir de aquí RLS aplica
SET ROLE app_user;

-- === CASO 1: t1 con licencia activa vigente ===
-- Esperado: 2 (doc1 finanzas + doc2 comercial; doc3 operaciones queda fuera de systems)
SET app.tenant_id='t1';
SET app.partner_id='';
SELECT COUNT(*) as case1_expected_2 FROM okf_partner_concepts;

-- === CASO 2: licencia con valid_until en el pasado, status intacto ===
-- Esperado: 0 (t3 solo tiene la licencia expirada por tiempo)
SET app.tenant_id='t3';
SELECT COUNT(*) as case2_expected_0 FROM okf_partner_concepts;

-- === CASO 3: t2 sin licencia ===
-- Esperado: 0
SET app.tenant_id='t2';
SELECT COUNT(*) as case3_expected_0 FROM okf_partner_concepts;

-- === CASO 4: partner dueño (portal) ===
-- Esperado: 3 propias / 0 del otro partner
SET app.tenant_id='';
SET app.partner_id='a1111111-1111-1111-1111-111111111111';
SELECT COUNT(*) as case4_own_expected_3 FROM okf_partner_concepts;
SELECT COUNT(*) as case4_other_expected_0 FROM okf_partner_concepts
WHERE partner_id='a2222222-2222-2222-2222-222222222222'::uuid;

-- === CASO 5: system_slug fuera de license.systems ===
-- Esperado: 0 (doc3 es 'operaciones', licencia solo cubre finanzas/comercial)
SET app.tenant_id='t1';
SET app.partner_id='';
SELECT COUNT(*) as case5_expected_0 FROM okf_partner_concepts
WHERE system_slug='operaciones';

-- === EXTRA: RLS de kdb_partner_licenses ===
-- t1 ve solo su licencia (1); t2 no ve ninguna (0)
SET app.tenant_id='t1';
SELECT COUNT(*) as licenses_t1_expected_1 FROM kdb_partner_licenses;
SET app.tenant_id='t2';
SELECT COUNT(*) as licenses_t2_expected_0 FROM kdb_partner_licenses;

-- Volver al rol de servicio y revertir todo el seed
RESET ROLE;
ROLLBACK;
