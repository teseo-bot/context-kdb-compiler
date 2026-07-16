-- migrations/008 · PA7-W2 (TRD-Aliados-Conocimiento-Certificado.md): gate de eval de paquete
-- previo a la PRIMERA activación de un contrato de aliado.
--
-- Propósito: okf_golden_questions y okf_eval_runs (003_okf_index.sql) ganan `package_id UUID`
-- nullable para poder registrar preguntas doradas y corridas de eval que pertenecen a un
-- PAQUETE de aliado (no a un tenant real). Namespace de tenant usado para estas filas:
-- 'partner:{partner_id}' (prefijo literal + UUID del partner) — evita colisión con tenant_id de
-- tenants reales bajo el mismo RLS FORCE por tenant de 004_rls.sql. La columna tenant_id sigue
-- NOT NULL y la política de aislamiento de 004 sigue aplicando tal cual (USING tenant_id =
-- current_setting('app.tenant_id')); solo cambia el VALOR que se compara: para filas de eval de
-- paquete es este namespace sintético, nunca un tenant_id real. Todo cliente que lea/escriba
-- estas filas hace SET app.tenant_id = 'partner:{partner_id}' (mismo patrón set_config que
-- src/indexing/indexer.ts), y además filtra explícito por package_id = $N (defensa en
-- profundidad: un mismo partner puede tener varios paquetes, todos bajo el mismo namespace).
--
-- Igual que 007_partner_index.sql, esta migración AÚN NO SE APLICA a producción (mismo estado
-- que la 007 antes de su aplicación — la épica G5 de la migración GCP-nativa gestiona cuándo se
-- aplican al Cold-Tier real las migraciones pendientes).

ALTER TABLE okf_golden_questions ADD COLUMN IF NOT EXISTS package_id UUID;
ALTER TABLE okf_eval_runs ADD COLUMN IF NOT EXISTS package_id UUID;

CREATE INDEX IF NOT EXISTS okf_golden_questions_package_idx
    ON okf_golden_questions(package_id) WHERE package_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS okf_eval_runs_package_idx
    ON okf_eval_runs(package_id, run_at DESC) WHERE package_id IS NOT NULL;
