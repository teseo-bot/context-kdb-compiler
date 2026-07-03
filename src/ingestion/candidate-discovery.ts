// K4-W4 v2 (BACKEND §B1, PLAN K4-W4): descubrimiento PULL de candidates para runV2.
//
// Hechos verificados (no re-derivar, ver PLAN-OKF-Epicas-K.md K4-W4 v2):
// - `leads` vive en SUPABASE (Hot-Tier), NO en Neon/Cold-Tier
//   (orchestrator/src/services/db.ts:97-100).
// - Terminal = LOWER(status) IN ('won','lost') OR pipeline_status = 'resolved'
//   (dos señales que coexisten: Kanban escribe `status` capitalizado, el handoff route
//   escribe `pipeline_status='resolved'`).
// - `leads.thread_id` existe (backfill = phone, migración 20260618013000).
// - `leads.updated_at` SÍ existe en el DDL real
//   (orchestrator/migrations/20260616170500_missing_tables.sql:16, columna `updated_at
//   TIMESTAMP WITH TIME ZONE DEFAULT NOW()`, no removida por migraciones posteriores) ->
//   se aplica el filtro temporal `updated_at >= since` cuando `sinceDays` se provee.
//
// Dos fuentes de candidates:
// (1) Conversaciones cerradas: query REST a Supabase PostgREST sobre `leads` -> INSERT
//     `knowledge_candidates` (kind='conversation_closed', source_ref='conv:{thread_id}',
//     fallback a 'conv:{lead_id}' si thread_id es nulo) con ON CONFLICT DO NOTHING.
// (2) Documentos sin candidate: `documents` del Cold-Tier que no tienen aún un candidate
//     con source_ref='doc:sha256:{hash}' -> INSERT kind='document_ingested'.
//
// El cliente Supabase se implementa con fetch nativo (REST PostgREST), inyectable vía
// `fetchImpl` para tests. Nunca se usa el SDK de Supabase (no está entre las deps permitidas).

import { PoolClient } from 'pg';

export interface SupabaseRestConfig {
  url: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

export interface DiscoverCandidatesOptions {
  tenantId: string;
  coldPool: { connect(): Promise<PoolClient> };
  supabase: SupabaseRestConfig;
  sinceDays?: number;
}

export interface DiscoverCandidatesResult {
  conversations: number;
  documents: number;
}

interface SupabaseLeadRow {
  id: string;
  thread_id: string | null;
  status: string | null;
  pipeline_status: string | null;
  updated_at?: string;
}

/**
 * Determina si un lead está en estado terminal según la doble señal de cierre
 * (ver PLAN K4-W4 v2): comparación case-insensitive de `status` contra 'won'/'lost',
 * O `pipeline_status === 'resolved'` (comparación exacta, escrito por el handoff route).
 */
function isTerminalLead(lead: SupabaseLeadRow): boolean {
  const status = (lead.status ?? '').toLowerCase();
  if (status === 'won' || status === 'lost') return true;
  return lead.pipeline_status === 'resolved';
}

function sourceRefForLead(lead: SupabaseLeadRow): string {
  return lead.thread_id ? `conv:${lead.thread_id}` : `conv:${lead.id}`;
}

/**
 * Consulta Supabase (Hot-Tier) vía REST PostgREST por leads del tenant en estado terminal.
 * NOTA: el filtro `LOWER(status) IN ('won','lost') OR pipeline_status = 'resolved'` no se
 * puede expresar de forma trivial en un único query PostgREST con OR sobre una función
 * (LOWER) y una columna distinta de forma portable, así que se trae el universo de leads
 * cerrados candidatos filtrando por tenant (y opcionalmente por updated_at) y se aplica el
 * filtro terminal exacto en memoria con `isTerminalLead` — evita depender de sintaxis
 * PostgREST avanzada (or=(...)) que es frágil de mantener a mano.
 */
async function fetchClosedLeads(
  supabase: SupabaseRestConfig,
  tenantId: string,
  sinceDays?: number
): Promise<SupabaseLeadRow[]> {
  const doFetch = supabase.fetchImpl ?? fetch;

  const params = new URLSearchParams();
  params.set('select', 'id,thread_id,status,pipeline_status,updated_at');
  params.set('tenant_id', `eq.${tenantId}`);

  if (sinceDays !== undefined) {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    params.set('updated_at', `gte.${since}`);
  }

  const url = `${supabase.url.replace(/\/$/, '')}/rest/v1/leads?${params.toString()}`;

  const res = await doFetch(url, {
    method: 'GET',
    headers: {
      apikey: supabase.serviceKey,
      Authorization: `Bearer ${supabase.serviceKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[candidate-discovery] Supabase leads query fallo (${res.status}): ${body}`);
  }

  const rows = (await res.json()) as SupabaseLeadRow[];
  return rows.filter(isTerminalLead);
}

async function insertCandidateIfAbsent(
  client: PoolClient,
  tenantId: string,
  kind: 'conversation_closed' | 'document_ingested',
  sourceRef: string,
  payloadSummary: string,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  const res = await client.query(
    `INSERT INTO knowledge_candidates (tenant_id, kind, source_ref, payload_summary, status, metadata)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [tenantId, kind, sourceRef, payloadSummary, JSON.stringify(metadata ?? {})]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * (2) Documentos del Cold-Tier sin candidate `doc:sha256:{hash}` todavía -> kind =
 * 'document_ingested'. Se usa NOT EXISTS contra knowledge_candidates para no requerir el
 * índice único (documento podría tener un candidate en cualquier status: si ya existe uno,
 * cualquiera sea su status, no se re-descubre).
 */
async function discoverDocumentCandidates(client: PoolClient, tenantId: string): Promise<number> {
  const res = await client.query(
    `SELECT d.document_hash, d.filename, d.metadata
     FROM documents d
     WHERE d.tenant_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_candidates kc
         WHERE kc.tenant_id = d.tenant_id
           AND kc.source_ref = 'doc:sha256:' || d.document_hash
       )`,
    [tenantId]
  );

  let inserted = 0;
  for (const row of res.rows as { document_hash: string; filename: string | null; metadata: unknown }[]) {
    const sourceRef = `doc:sha256:${row.document_hash}`;
    const payloadSummary = row.filename ? `Documento ingerido: ${row.filename}` : 'Documento ingerido';
    // K9-W1 (SPEC-K9 §2.3): copiar documents.metadata.hocflit_hint -> candidate.metadata,
    // solo si existe.
    const docMetadata = (row.metadata ?? {}) as Record<string, unknown>;
    const candidateMetadata = docMetadata.hocflit_hint
      ? { hocflit_hint: docMetadata.hocflit_hint }
      : undefined;
    const ok = await insertCandidateIfAbsent(
      client,
      tenantId,
      'document_ingested',
      sourceRef,
      payloadSummary,
      candidateMetadata
    );
    if (ok) inserted++;
  }
  return inserted;
}

async function discoverConversationCandidates(
  client: PoolClient,
  tenantId: string,
  supabase: SupabaseRestConfig,
  sinceDays?: number
): Promise<number> {
  const closedLeads = await fetchClosedLeads(supabase, tenantId, sinceDays);

  let inserted = 0;
  for (const lead of closedLeads) {
    const sourceRef = sourceRefForLead(lead);
    const payloadSummary = `Conversación cerrada (lead ${lead.id}, status=${lead.status ?? ''}, pipeline_status=${
      lead.pipeline_status ?? ''
    })`;
    const ok = await insertCandidateIfAbsent(client, tenantId, 'conversation_closed', sourceRef, payloadSummary);
    if (ok) inserted++;
  }
  return inserted;
}

/**
 * Paso 0 opcional de runV2: descubre candidates nuevos desde las fuentes pull (Supabase
 * leads cerrados + documents del Cold-Tier sin candidate) e inserta en knowledge_candidates
 * de forma idempotente (ON CONFLICT DO NOTHING sobre el índice único parcial de la
 * migración 005). No lanza hacia arriba por errores de una sola fuente que no sea fatal;
 * los errores de red/HTTP de Supabase SÍ se propagan (el caller decide cómo tratarlos).
 */
export async function discoverCandidates(opts: DiscoverCandidatesOptions): Promise<DiscoverCandidatesResult> {
  const client = await opts.coldPool.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', opts.tenantId]);

    const conversations = await discoverConversationCandidates(client, opts.tenantId, opts.supabase, opts.sinceDays);
    const documents = await discoverDocumentCandidates(client, opts.tenantId);

    return { conversations, documents };
  } finally {
    await client.query('RESET app.tenant_id');
    client.release();
  }
}
