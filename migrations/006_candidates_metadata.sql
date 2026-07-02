-- K9-W1: sesgo HOCFLIT de origen — knowledge_candidates gana metadata JSONB para propagar
-- documents.metadata.hocflit_hint (discovery) hacia el poller/distiller-v2.
-- Ver SPEC-K9-Interfaces-Ingesta.md §2.1 (copiado textual).
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
