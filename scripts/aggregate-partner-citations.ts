#!/usr/bin/env npx tsx

/**
 * PA7-W3: Agregador diario de citas de aliados (TRD §9, [INV-5.4])
 *
 * Job diario (cron Cloud Run) que cuenta cuántas veces se citó conocimiento certificado de cada
 * aliado y escribe SOLO conteos en `partner_citation_stats` (plano de CONTROL). [INV-5.4] es LEY:
 * a esa tabla jamás llega texto de conversaciones, leads ni identidad de usuarios del tenant —
 * por eso la agregación se hace ENTERAMENTE en SQL (un query agregado por fuente), sin traer
 * filas crudas al proceso.
 *
 * Planos involucrados:
 *  - Hot-Tier del tenant (`hotPool`): fuente de las citas. Las citas certificadas son paths
 *    `@{partner_slug}/{system}/{slug}.md` guardados como array JSON en
 *    `ephemeral_state.state->'kdb_citations'` (estado por conversación del orquestador) y,
 *    donde exista, `lead_summaries.kdb_citations`.
 *  - Cold-Tier (`coldPool`): `kdb_partner_licenses(contract_id, tenant_id, partner_slug, ...)`
 *    resuelve el mapeo path -> contrato.
 *  - Plano de CONTROL (`controlPool`): destino `partner_citation_stats(contract_id, day, citations)`.
 *
 * La lógica reutilizable vive en `aggregateCitations(deps)` (mismo patrón deps-inyectadas que
 * `scripts/export-partner-bundle.ts` / `scripts/seed-partner-demo.ts`), para que
 * `src/partners/aggregate-partner-citations.test.ts` la ejecute contra Postgres local (los tres
 * pools apuntando a la misma BD, simulando los 3 planos), y `main()` (abajo) la ejecute contra
 * infra real (HOT_TIER_URL / COLD_TIER_URL / CONTROL_DB_URL).
 *
 * v1: single-hot-tier (un solo tenant-fleet, un solo Hot-Tier). Multi-hot-tier (un pool por
 * tenant/fleet) queda pendiente para cuando exista federación real (ADR-205) — en ese momento
 * este job deberá iterar sobre N hotPools en vez de uno solo.
 *
 * Uso:
 *   HOT_TIER_URL=postgres://... COLD_TIER_URL=postgres://... CONTROL_DB_URL=postgres://... \
 *     npx tsx scripts/aggregate-partner-citations.ts [--since-days=7]
 */

import { Pool } from 'pg';

// ==================== Núcleo testeable ====================

export interface AggregateDeps {
  hotPool: Pool; // Hot-Tier del tenant (fuente de citas)
  coldPool: Pool; // Cold-Tier (kdb_partner_licenses para resolver contrato)
  controlPool: Pool; // plano de control (destino partner_citation_stats)
  sinceDays?: number; // ventana hacia atrás, default 7
  now?: () => Date;
}

export interface AggregateResult {
  rowsUpserted: number;
  citationsCounted: number;
  sourcesScanned: string[];
}

/**
 * Fuentes pluggables de citas en el Hot-Tier. `citationsSql` es una expresión SQL FIJA (config
 * interna, nunca input externo) que referencia columnas de `table`; puede ser un campo JSONB
 * suelto (`state->'kdb_citations'`) o una columna JSONB de primer nivel (`kdb_citations`).
 */
interface SourceConfig {
  table: string;
  citationsSql: string;
  tsCol: string;
}

const SOURCES: SourceConfig[] = [
  { table: 'ephemeral_state', citationsSql: "state->'kdb_citations'", tsCol: 'updated_at' },
  { table: 'lead_summaries', citationsSql: 'kdb_citations', tsCol: 'created_at' },
];

interface CitationCount {
  tenant_id: string;
  partner_slug: string;
  day: string; // 'YYYY-MM-DD'
  citations: number;
}

/**
 * ¿Existe la tabla `table` en `pool`? Usa `to_regclass` (barato, no lanza si no existe).
 */
async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.' || $1) IS NOT NULL AS exists`,
    [table]
  );
  return rows[0]?.exists ?? false;
}

/**
 * UN query agregado en SQL para una fuente: expande el array JSON de citas, filtra paths
 * certificados (`@...`), extrae el partner_slug, agrupa por (tenant_id, partner_slug, day) dentro
 * de la ventana `[now() - sinceDays, now()]`. Nunca trae texto de conversaciones al proceso — solo
 * conteos agregados salen de Postgres.
 *
 * Guardas necesarias en el WHERE:
 *  - `jsonb_typeof(citationsSql) = 'array'`: `state->'kdb_citations'` puede no existir (NULL) o no
 *    ser un array — sin esta guarda `jsonb_array_elements_text` lanzaría error.
 *  - `cita LIKE '@%'`: solo paths de conocimiento certificado; cualquier otro valor se ignora.
 */
async function countCitationsForSource(
  pool: Pool,
  source: SourceConfig,
  sinceDays: number,
  referenceNow: Date
): Promise<CitationCount[]> {
  const sql = `
    SELECT
      tenant_id::text AS tenant_id,
      split_part(substr(cita, 2), '/', 1) AS partner_slug,
      to_char(date_trunc('day', ${source.tsCol}), 'YYYY-MM-DD') AS day,
      count(*)::int AS citations
    FROM ${source.table}, LATERAL jsonb_array_elements_text(${source.citationsSql}) AS cita
    WHERE jsonb_typeof(${source.citationsSql}) = 'array'
      AND cita LIKE '@%'
      AND ${source.tsCol} >= $1::timestamptz - ($2 || ' days')::interval
    GROUP BY tenant_id, partner_slug, day
  `;
  const { rows } = await pool.query<CitationCount>(sql, [referenceNow.toISOString(), String(sinceDays)]);
  return rows;
}

/**
 * Resuelve contract_id para el set de (tenant_id, partner_slug) observado, vía `kdb_partner_licenses`
 * en el Cold-Tier. SIN filtro de status/vigencia: las citas históricas de una licencia ya expirada
 * siguen siendo metering legítimo del período en que estuvo activa (no se re-escribe historia).
 * Pares (tenant,slug) que no resuelven a contrato quedan huérfanos — no se inventa un contrato.
 */
async function resolveContracts(
  coldPool: Pool,
  pairs: { tenant_id: string; partner_slug: string }[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>(); // key `${tenant_id}::${partner_slug}` -> contract_id
  if (pairs.length === 0) return map;

  const tenantIds = pairs.map((p) => p.tenant_id);
  const partnerSlugs = pairs.map((p) => p.partner_slug);

  const { rows } = await coldPool.query<{ contract_id: string; tenant_id: string; partner_slug: string }>(
    `SELECT l.contract_id, l.tenant_id, l.partner_slug
     FROM kdb_partner_licenses l
     JOIN (SELECT unnest($1::text[]) AS tenant_id, unnest($2::text[]) AS partner_slug) AS pairs
       ON l.tenant_id = pairs.tenant_id AND l.partner_slug = pairs.partner_slug`,
    [tenantIds, partnerSlugs]
  );

  for (const row of rows) {
    map.set(`${row.tenant_id}::${row.partner_slug}`, row.contract_id);
  }
  return map;
}

/**
 * Ejecuta la agregación diaria completa:
 *   1. Por cada fuente pluggable existente en hotPool, UN query agregado (sin filas crudas).
 *   2. Suma entre fuentes en memoria (solo conteos, ya agregados) por (tenant_id, partner_slug, day).
 *   3. Resuelve contrato en coldPool para el set de (tenant_id, partner_slug) observado.
 *   4. Upsert idempotente (SOBRESCRIBE, no acumula) en controlPool: `partner_citation_stats`.
 *   5. Reporta resumen por fuente + huérfanas por consola. NUNCA imprime texto de citas
 *      individuales de conversaciones — solo paths de conceptos (partner_slug) y conteos.
 */
export async function aggregateCitations(deps: AggregateDeps): Promise<AggregateResult> {
  const sinceDays = deps.sinceDays ?? 7;
  const referenceNow = deps.now ? deps.now() : new Date();

  const sourcesScanned: string[] = [];
  const perSourceCounts: CitationCount[][] = [];

  for (const source of SOURCES) {
    const exists = await tableExists(deps.hotPool, source.table);
    if (!exists) {
      console.log(`[aggregate-partner-citations] fuente '${source.table}' no existe — se omite`);
      continue;
    }
    const counts = await countCitationsForSource(deps.hotPool, source, sinceDays, referenceNow);
    sourcesScanned.push(source.table);
    perSourceCounts.push(counts);
    console.log(
      `[aggregate-partner-citations] fuente '${source.table}': ${counts.length} grupos (tenant,partner,day), ` +
        `${counts.reduce((acc, c) => acc + c.citations, 0)} citas`
    );
  }

  // 2. Sumar entre fuentes por (tenant_id, partner_slug, day).
  const merged = new Map<string, { tenant_id: string; partner_slug: string; day: string; citations: number }>();
  for (const counts of perSourceCounts) {
    for (const c of counts) {
      const key = `${c.tenant_id}::${c.partner_slug}::${c.day}`;
      const existing = merged.get(key);
      if (existing) {
        existing.citations += c.citations;
      } else {
        merged.set(key, { ...c });
      }
    }
  }

  const citationsCounted = [...merged.values()].reduce((acc, c) => acc + c.citations, 0);

  // 3. Resolver contrato en coldPool para el set (tenant_id, partner_slug) observado.
  const pairKeySet = new Set<string>();
  const pairs: { tenant_id: string; partner_slug: string }[] = [];
  for (const c of merged.values()) {
    const pk = `${c.tenant_id}::${c.partner_slug}`;
    if (!pairKeySet.has(pk)) {
      pairKeySet.add(pk);
      pairs.push({ tenant_id: c.tenant_id, partner_slug: c.partner_slug });
    }
  }
  const contractByPair = await resolveContracts(deps.coldPool, pairs);

  // 4. Upsert idempotente (SOBRESCRIBE) en controlPool, agrupando por (contract_id, day).
  const byContractDay = new Map<string, { contract_id: string; day: string; citations: number }>();
  const orphans: { tenant_id: string; partner_slug: string; citations: number }[] = [];

  for (const c of merged.values()) {
    const contractId = contractByPair.get(`${c.tenant_id}::${c.partner_slug}`);
    if (!contractId) {
      orphans.push({ tenant_id: c.tenant_id, partner_slug: c.partner_slug, citations: c.citations });
      continue;
    }
    const key = `${contractId}::${c.day}`;
    const existing = byContractDay.get(key);
    if (existing) {
      existing.citations += c.citations;
    } else {
      byContractDay.set(key, { contract_id: contractId, day: c.day, citations: c.citations });
    }
  }

  for (const row of byContractDay.values()) {
    await deps.controlPool.query(
      `INSERT INTO partner_citation_stats (contract_id, day, citations)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (contract_id, day) DO UPDATE SET
         citations = EXCLUDED.citations,
         updated_at = now()`,
      [row.contract_id, row.day, row.citations]
    );
  }

  // 5. Resumen por consola. Solo partner_slug (path de concepto) y conteos — NUNCA texto.
  console.log(
    `[aggregate-partner-citations] resumen: ${byContractDay.size} filas upsert, ${citationsCounted} citas contadas, ` +
      `fuentes escaneadas: ${sourcesScanned.join(', ') || '(ninguna)'}`
  );
  if (orphans.length > 0) {
    console.log(
      `[aggregate-partner-citations] AVISO: ${orphans.length} grupos huérfanos (sin contrato en kdb_partner_licenses), no insertados:`
    );
    for (const o of orphans) {
      console.log(`  - tenant=${o.tenant_id} partner_slug=${o.partner_slug} citas=${o.citations}`);
    }
  }

  return {
    rowsUpserted: byContractDay.size,
    citationsCounted,
    sourcesScanned,
  };
}

// ==================== main(): wiring REAL ====================

function parseArgs(argv: string[]): { sinceDays: number } {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  const sinceDaysRaw = args['since-days'];
  const sinceDays = sinceDaysRaw ? Number(sinceDaysRaw) : 7;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) {
    throw new Error(`--since-days inválido: ${sinceDaysRaw}`);
  }
  return { sinceDays };
}

async function main(): Promise<void> {
  const hotTierUrl = process.env.HOT_TIER_URL;
  const coldTierUrl = process.env.COLD_TIER_URL;
  const controlDbUrl = process.env.CONTROL_DB_URL;

  if (!hotTierUrl || !coldTierUrl || !controlDbUrl) {
    console.error(
      'Uso: HOT_TIER_URL=postgres://... COLD_TIER_URL=postgres://... CONTROL_DB_URL=postgres://... ' +
        'npx tsx scripts/aggregate-partner-citations.ts [--since-days=7]'
    );
    process.exit(1);
  }

  const { sinceDays } = parseArgs(process.argv.slice(2));

  const hotPool = new Pool({ connectionString: hotTierUrl });
  const coldPool = new Pool({ connectionString: coldTierUrl });
  const controlPool = new Pool({ connectionString: controlDbUrl });

  try {
    const result = await aggregateCitations({ hotPool, coldPool, controlPool, sinceDays });
    console.log('[aggregate-partner-citations] OK', result);
  } catch (error) {
    console.error('[aggregate-partner-citations] Error durante la agregación:', error);
    process.exit(1);
  } finally {
    await Promise.all([hotPool.end(), coldPool.end(), controlPool.end()]);
  }
}

// Solo ejecutar main() si se llama directamente (no en import, p.ej. desde el test).
if (require.main === module || process.argv[1]?.endsWith('aggregate-partner-citations.ts')) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
