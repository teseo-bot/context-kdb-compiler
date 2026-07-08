-- Test de RLS para okf_partner_concepts + kdb_partner_licenses
-- Transacción de prueba que se revierte al final

BEGIN;

-- UUIDs constantes para referencias
-- partner1: a1111111-1111-1111-1111-111111111111
-- partner2: a2222222-2222-2222-2222-222222222222
-- pkg1: b1111111-1111-1111-1111-111111111111
-- pkg2: b2222222-2222-2222-2222-222222222222
-- contract1: c1111111-1111-1111-1111-111111111111
-- contract2: c2222222-2222-2222-2222-222222222222
-- contract3: c3333333-3333-3333-3333-333333333333

-- === SETUP: Insertar conceptos de partner 1 ===
SET app.partner_id='a1111111-1111-1111-1111-111111111111';
INSERT INTO okf_partner_concepts (
    id, partner_id, package_id, version, path, gcs_path, frontmatter, body_text,
    content_sha256, altitude, system_slug, updated_at
) VALUES
    (
        'd1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111111'::uuid,
        'b1111111-1111-1111-1111-111111111111'::uuid,
        1, 'doc1.md', 'gs://bucket/doc1.md',
        '{"title":"Doc 1"}', 'Content for doc 1',
        'hash1', 2, 'finanzas', NOW()
    ),
    (
        'd1111111-1111-1111-1111-111111111112',
        'a1111111-1111-1111-1111-111111111111'::uuid,
        'b1111111-1111-1111-1111-111111111111'::uuid,
        1, 'doc2.md', 'gs://bucket/doc2.md',
        '{"title":"Doc 2"}', 'Content for doc 2',
        'hash2', 3, 'comercial', NOW()
    ),
    (
        'd1111111-1111-1111-1111-111111111113',
        'a1111111-1111-1111-1111-111111111111'::uuid,
        'b1111111-1111-1111-1111-111111111111'::uuid,
        1, 'doc3.md', 'gs://bucket/doc3.md',
        '{"title":"Doc 3"}', 'Content for doc 3',
        'hash3', 1, 'operaciones', NOW()
    );

-- === SETUP: Insertar conceptos de partner 2 (para probar partner_portal_read) ===
SET app.partner_id='a2222222-2222-2222-2222-222222222222';
INSERT INTO okf_partner_concepts (
    id, partner_id, package_id, version, path, gcs_path, frontmatter, body_text,
    content_sha256, altitude, system_slug, updated_at
) VALUES
    (
        'd2222222-2222-2222-2222-222222222222',
        'a2222222-2222-2222-2222-222222222222'::uuid,
        'b2222222-2222-2222-2222-222222222222'::uuid,
        1, 'other.md', 'gs://bucket/other.md',
        '{"title":"Other"}', 'Content from partner 2',
        'hash_other', 2, 'finanzas', NOW()
    );

-- === SETUP: Licencia activa vigente para t1 (validar case 1) ===
INSERT INTO kdb_partner_licenses (
    contract_id, tenant_id, partner_id, package_id, version,
    systems, altitude_max, modules, valid_from, valid_until, status, synced_at
) VALUES (
    'c1111111-1111-1111-1111-111111111111'::uuid,
    't1',
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'b1111111-1111-1111-1111-111111111111'::uuid,
    1,
    ARRAY['finanzas','comercial'],
    3,
    ARRAY['read','search'],
    NOW() - INTERVAL '1 day',
    NOW() + INTERVAL '30 days',
    'active',
    NOW()
);

-- === SETUP: Licencia con valid_until en el pasado (case 2) ===
INSERT INTO kdb_partner_licenses (
    contract_id, tenant_id, partner_id, package_id, version,
    systems, altitude_max, modules, valid_from, valid_until, status, synced_at
) VALUES (
    'c2222222-2222-2222-2222-222222222222'::uuid,
    't1',
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'b1111111-1111-1111-1111-111111111111'::uuid,
    1,
    ARRAY['finanzas','comercial'],
    3,
    ARRAY['read','search'],
    NOW() - INTERVAL '60 days',
    NOW() - INTERVAL '30 days',
    'active',
    NOW()
);

-- === SETUP: Sin licencia para t2 (case 3) ===
-- (No insertar nada para t2)

-- === TEST CASE 1: Con app.tenant_id='t1' y licencia activa vigente ===
SET app.tenant_id='t1';
SET app.partner_id='';
-- Esperado: 2 filas (doc1.md y doc2.md que tienen system_slug en ['finanzas','comercial'] y altitude <= 3)
-- doc3.md NO debe verse porque su system_slug='operaciones' no está en systems=['finanzas','comercial']
SELECT COUNT(*) as case1_count FROM okf_partner_concepts
WHERE partner_id='a1111111-1111-1111-1111-111111111111'::uuid;

-- === TEST CASE 2: Licencia con valid_until en el pasado (sin cambiar status) ===
-- Misma sesión, mismo tenant, misma query
-- Esperado: 0 filas (la licencia está expirada)
SELECT COUNT(*) as case2_count FROM okf_partner_concepts
WHERE partner_id='a1111111-1111-1111-1111-111111111111'::uuid;

-- === TEST CASE 3: app.tenant_id='t2' sin licencia ===
SET app.tenant_id='t2';
-- Esperado: 0 filas (t2 no tiene licencia)
SELECT COUNT(*) as case3_count FROM okf_partner_concepts;

-- === TEST CASE 4: app.partner_id del dueño (portal) ===
SET app.tenant_id='';
SET app.partner_id='a1111111-1111-1111-1111-111111111111';
-- Esperado: 3 filas (ve todo lo suyo desde partner_portal_read)
SELECT COUNT(*) as case4_own_count FROM okf_partner_concepts
WHERE partner_id='a1111111-1111-1111-1111-111111111111'::uuid;

-- Mismo partner, diferente partner
-- Esperado: 0 filas (no ve partner 2)
SELECT COUNT(*) as case4_other_count FROM okf_partner_concepts
WHERE partner_id='a2222222-2222-2222-2222-222222222222'::uuid;

-- === TEST CASE 5: Concepto con system_slug fuera de l.systems ===
-- Volvemos a t1 pero primero verificamos que doc3 (operaciones) no se ve
SET app.tenant_id='t1';
SET app.partner_id='';
-- doc3 tiene system_slug='operaciones' que NO está en la licencia systems=['finanzas','comercial']
-- Esperado: 0 filas para doc3 específicamente
SELECT COUNT(*) as case5_outside_systems FROM okf_partner_concepts
WHERE system_slug='operaciones' AND partner_id='a1111111-1111-1111-1111-111111111111'::uuid;

-- === TEST: Verificar kdb_partner_licenses RLS ===
-- t1 ve su licencia
SET app.tenant_id='t1';
SELECT COUNT(*) as licenses_t1_count FROM kdb_partner_licenses
WHERE tenant_id='t1';

-- t2 no ve la licencia de t1
SET app.tenant_id='t2';
SELECT COUNT(*) as licenses_t2_count FROM kdb_partner_licenses
WHERE tenant_id='t1';

-- === ROLLBACK: Limpiar todos los datos de prueba ===
ROLLBACK;
