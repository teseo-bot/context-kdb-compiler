-- K4-W4 v2: índice único parcial para idempotencia del descubrimiento pull de candidates.
-- Evita duplicar knowledge_candidates para el mismo (tenant_id, source_ref) mientras el
-- candidate sigue "vivo" en el pipeline (pending/processing/drafted). Permite re-intento
-- tras 'error'/'discarded' (no cubiertos por el índice -> un nuevo INSERT con el mismo
-- source_ref es válido en esos estados).
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_candidates_tenant_source_active_uniq
  ON knowledge_candidates(tenant_id, source_ref)
  WHERE status IN ('pending','processing','drafted');
