// K4-W4 v2 (BACKEND §B1, PLAN K4-W4): descubrimiento PULL de candidates para runV2.
//
// ─── Por qué aquí ya no hay conversaciones ──────────────────────────────────────────────
//
// Este módulo nació con DOS fuentes. La de conversaciones cerradas consultaba `leads` en
// SUPABASE por REST (PostgREST). Supabase se retiró con ADR-206 (GCP-Native): `leads` vive
// hoy en el hot-tier de `micontexto-tenant1` y el deploy del orquestador lo declara sin
// ambigüedad — «SUPABASE_* retirados: código muerto». Esa fuente no podía funcionar en
// producción.
//
// Y de hecho NUNCA corrió, ni siquiera antes del retiro: `runV2` ejecutaba el paso 0 sólo
// si recibía `opts.supabase`, y nadie lo pasaba jamás — ni la ruta M2M
// `/internal/distill-candidates` (src/server.ts) ni el CLI del final de candidate-poller.ts.
// Sus tests pasaban en verde porque inyectaban un `fetch` falso: verde sobre un camino
// imposible.
//
// El daño real no era el código muerto en sí, sino que la mitad VIVA —documentos sin
// candidate— quedaba detrás de la MISMA llave: `discoverCandidates` exigía `supabase`, así
// que el descubrimiento de documentos era inalcanzable por arrastre.
//
// Las conversaciones entran por el emisor PUSH del orquestador (`emitCandidate`,
// src/services/knowledge-candidates.ts — «Emisor V1» de BACKEND-SPECS-OKF §B1), que escribe
// `knowledge_candidates` en el plano privado del tenant. Es el camino que el diseño ya
// prevé; este módulo no lo duplica.
//
// ─── La fuente que queda ────────────────────────────────────────────────────────────────
//
// Documentos del plano del tenant que aún no tienen un candidate `doc:sha256:{hash}` ->
// INSERT `knowledge_candidates` con kind='document_ingested'. Idempotente por NOT EXISTS.

import { PoolClient } from 'pg';

export interface DiscoverCandidatesOptions {
  tenantId: string;
  coldPool: { connect(): Promise<PoolClient> };
}

export interface DiscoverCandidatesResult {
  documents: number;
}

/**
 * Documentos sin candidate `doc:sha256:{hash}` todavía -> kind = 'document_ingested'.
 * Se usa NOT EXISTS contra knowledge_candidates para no requerir el índice único (un
 * documento podría tener un candidate en cualquier status: si ya existe uno, cualquiera sea
 * su status, no se re-descubre).
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

    const ins = await client.query(
      `INSERT INTO knowledge_candidates (tenant_id, kind, source_ref, payload_summary, status, metadata)
       VALUES ($1, 'document_ingested', $2, $3, 'pending', $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [tenantId, sourceRef, payloadSummary, JSON.stringify(candidateMetadata ?? {})]
    );
    if ((ins.rowCount ?? 0) > 0) inserted++;
  }
  return inserted;
}

/**
 * Paso 0 de runV2: descubre candidates nuevos desde la fuente pull (documentos del plano del
 * tenant sin candidate) e inserta en knowledge_candidates de forma idempotente (ON CONFLICT
 * DO NOTHING sobre el índice único parcial de la migración 005).
 */
export async function discoverCandidates(opts: DiscoverCandidatesOptions): Promise<DiscoverCandidatesResult> {
  const client = await opts.coldPool.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', opts.tenantId]);

    const documents = await discoverDocumentCandidates(client, opts.tenantId);

    return { documents };
  } finally {
    await client.query('RESET app.tenant_id');
    client.release();
  }
}
