-- 011_kdb_colas_destilador.sql — las dos colas del destilador bajan al plano privado
--
-- Cierra el "ALCANCE PENDIENTE DE DECISIÓN" que 009_kdb_schema.sql dejó anotado al final
-- de su propio archivo, para las dos tablas donde su recomendación era «SÍ baja»:
--
--   · knowledge_candidates   cola V1→V2 del destilador
--   · okf_merge_proposals    cola HITL de merges
--
-- Con el destilador por tenant (ADR-210 D-210.4) su cola tiene que vivir en el plano del
-- tenant. Y son, además, lo más sensible que quedaba en el plano compartido:
-- `knowledge_candidates.payload_summary` guarda resúmenes literales de conversaciones
-- cerradas con clientes reales (hasta 2000 caracteres, ver
-- context-kdb-orchestrator/src/services/knowledge-candidates.ts). Terminar el aislamiento
-- con los documentos procesados en el plano privado y las conversaciones en el compartido
-- habría sido justo al revés de lo que persigue D-210.2.
--
-- Decisión del CEO, 2026-07-30. Las dos tablas estaban VACÍAS en
-- micontexto-coldtier:context-kdb-db al medir el corpus ese mismo día, así que esto es DDL
-- puro: no migra ni una fila y no hay nada que perder.
--
-- ALCANCE: solo esas dos. `okf_golden_questions` y `okf_eval_runs` se quedan donde están —
-- 008_partner_eval.sql les añadió `package_id` para el gate de eval de paquetes de ALIADO,
-- así que hoy son de doble uso (eval del tenant y eval de paquete de aliado) y partirlas o
-- duplicarlas es una decisión de producto, no de esquema. Sigue abierta.
--
-- Se aplica en la instancia DEL TENANT (micontexto-tenant{N}:hot-tier), NO en el Cold-Tier.
--
-- MISMO MÉTODO QUE 009, y por las mismas razones:
--   1. Estado FINAL, no la secuencia histórica: se pliegan aquí el índice único parcial de
--      005, la columna `metadata` de 006 y la columna `review_meta` del propio 003, en vez
--      de reproducir los ALTER.
--   2. Índices con prefijo `kdb_` para no colisionar si algún día conviven con los de
--      `public` en la misma base.
--   3. `tenant_id` sin DEFAULT: un INSERT que olvide el tenant falla en seco en vez de
--      aterrizar en un tenant fantasma invisible bajo RLS. (Estas dos tablas ya lo cumplían
--      en el original; se deja dicho para que nadie lo "arregle".)
--
-- APLICAR CON `app_rw`, no con `postgres`. Es miembro de cloudsqlsuperuser, puede crear y
-- QUEDA DUEÑO, que es lo que el servicio necesita. Aplicar 009 como `postgres` es lo que
-- dejó inservible a micontexto-tenant2-503516: allí `app_rw` no ve las tablas de `kdb`.
-- A diferencia de 009, esta migración NO depende de eso: el bloque de GRANTs del final lo
-- arregla aunque se aplique con otro rol.
--
-- Ensayo antes de aplicar (barato, y descarta el error tonto):
--   BEGIN; \i migrations/011_kdb_colas_destilador.sql; ROLLBACK;
--
-- Reversión limpia: 011_kdb_colas_destilador.down.sql

CREATE SCHEMA IF NOT EXISTS kdb;

-- ── Cola V1 → V2 del destilador ─────────────────────────────────────────────────
-- Escritor: el orquestador (emitCandidate). Lector: el poller del compiler del tenant.

CREATE TABLE IF NOT EXISTS kdb.knowledge_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('conversation_closed','document_ingested','event')),
    source_ref TEXT NOT NULL,
    payload_summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','drafted','discarded','error')),
    error TEXT,
    -- K9-W1 (006): sesgo HOCFLIT de origen, propaga documents.metadata.hocflit_hint.
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS kdb_knowledge_candidates_status_idx
    ON kdb.knowledge_candidates(tenant_id, status);

-- K4-W4 v2 (005): idempotencia del descubrimiento pull. Evita duplicar el candidate del
-- mismo (tenant_id, source_ref) mientras sigue vivo en el pipeline; 'error'/'discarded'
-- quedan FUERA del índice a propósito, para permitir el reintento.
CREATE UNIQUE INDEX IF NOT EXISTS kdb_knowledge_candidates_tenant_source_active_uniq
    ON kdb.knowledge_candidates(tenant_id, source_ref)
    WHERE status IN ('pending','processing','drafted');

-- ── Cola HITL de merges ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kdb.okf_merge_proposals (
    proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    target_path TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','update')),
    altitude SMALLINT NOT NULL CHECK (altitude BETWEEN 1 AND 5),
    draft_ids UUID[] NOT NULL,
    new_content TEXT NOT NULL,
    previous_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'pending_auto'
        CHECK (status IN ('pending_auto','pending_hitl','approved','rejected','applied')),
    reviewer TEXT,
    reviewed_at TIMESTAMPTZ,
    -- BACKEND §D2 (003): metadata de revisión HITL.
    review_meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS kdb_okf_merge_proposals_status_idx
    ON kdb.okf_merge_proposals(tenant_id, status);

-- ── GRANTs explícitos ───────────────────────────────────────────────────────────
--
-- 009 no trae ni un GRANT, y por eso su resultado depende de con qué rol se aplique:
-- aplicada como `postgres`, el servicio (`app_rw`) no ve las tablas y el delator es una
-- asimetría desconcertante — information_schema devuelve 0 tablas mientras pg_indexes
-- muestra los índices. Aquí se cierra esa dependencia.
--
-- Condicionado a que el rol exista: en dev/CI no hay `app_rw` y un GRANT a un rol
-- inexistente aborta la migración entera.

DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        GRANT USAGE ON SCHEMA kdb TO app_rw;
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON kdb.knowledge_candidates, kdb.okf_merge_proposals
            TO app_rw;
    END IF;
END
$grants$;

-- ── Nota de rollout ─────────────────────────────────────────────────────────────
--
-- Igual que 010, esta migración NO crea, altera ni borra ninguna política RLS: en el plano
-- privado de un solo tenant el aislamiento lo da la base, no la política. El intercambio de
-- políticas sigue siendo la 011 gateada del plan original (ahora renumerada a 012+).
--
-- Y NO borra las tablas homónimas del Cold-Tier. La purga del plano compartido es un paso
-- posterior y deliberado del retiro (fase D, paso 8), después del soak.
