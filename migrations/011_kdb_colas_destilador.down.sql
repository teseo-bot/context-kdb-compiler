-- 011_kdb_colas_destilador.down.sql — reversión de 011.
--
-- Seguro mientras las dos colas estén vacías, que es el estado en que se aplicó
-- (medido 2026-07-30: 0 filas en las dos, en el Cold-Tier y en el plano local).
--
-- 🔴 DESPUÉS de que el orquestador empiece a escribir en el plano local, esto BORRA DATOS:
-- resúmenes de conversaciones que todavía no han pasado por el destilador. Comprobar antes:
--
--   SELECT count(*) FROM kdb.knowledge_candidates;
--   SELECT count(*) FROM kdb.okf_merge_proposals;
--
-- Si no dan 0, no revertir sin volcar primero.
--
-- No toca el schema `kdb` (lo comparte con 009/010) ni las tablas homónimas del Cold-Tier.

DROP INDEX IF EXISTS kdb.kdb_okf_merge_proposals_status_idx;
DROP TABLE IF EXISTS kdb.okf_merge_proposals;

DROP INDEX IF EXISTS kdb.kdb_knowledge_candidates_tenant_source_active_uniq;
DROP INDEX IF EXISTS kdb.kdb_knowledge_candidates_status_idx;
DROP TABLE IF EXISTS kdb.knowledge_candidates;
