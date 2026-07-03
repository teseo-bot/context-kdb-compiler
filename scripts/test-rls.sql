-- Test de aislamiento RLS por tenant_id
-- Paso a paso comentado para verificar que RLS aisla correctamente
-- Ejecución: psql -U postgres -h localhost -p 5436 -d postgres -f scripts/test-rls.sql

-- Paso 1: Establecer tenant_id='t1' e insertar una fila mínima en okf_concepts
SET app.tenant_id='t1';
INSERT INTO okf_concepts (
    tenant_id, path, frontmatter, body_text, content_sha256, altitude, system_slug
) VALUES (
    't1',
    'c-comercial/test.md',
    '{}',
    'test',
    'abc',
    1,
    'c-comercial'
);

-- Paso 2: Cambiar tenant_id a 't2' e intentar SELECT
-- Esperado: 0 filas (RLS debe aislar)
SET app.tenant_id='t2';
SELECT COUNT(*) as count_tenant_t2 FROM okf_concepts;

-- Paso 3: RESET app.tenant_id (sin setting, RLS debe devolver 0 filas)
-- Esperado: 0 filas (current_setting sin default devuelve null)
RESET app.tenant_id;
SELECT COUNT(*) as count_no_setting FROM okf_concepts;

-- Paso 4: Volver a 't1' para verificar que la fila está accesible
SET app.tenant_id='t1';
SELECT COUNT(*) as count_back_to_t1 FROM okf_concepts;

-- Paso 5: Limpieza final (volver a 't1' y borrar la fila de test)
SET app.tenant_id='t1';
DELETE FROM okf_concepts WHERE tenant_id='t1' AND path='c-comercial/test.md';

-- Confirmación de limpieza
SELECT COUNT(*) as final_cleanup_count FROM okf_concepts WHERE tenant_id='t1';
