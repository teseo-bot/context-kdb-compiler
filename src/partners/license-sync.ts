/**
 * PA4-W3a: Ruta interna de sync de licencias (lado compiler)
 *
 * El panel (teseo-control) proyecta un contrato de aliado a una fila de
 * `kdb_partner_licenses` (migrations/007_partner_index.sql) y llama a la ruta M2M
 * `/internal/partner-license-sync` para reflejarla aquí. Este módulo contiene SOLO la
 * lógica de upsert/delete contra Postgres y el schema Zod del body de la ruta — la ruta en
 * sí vive en src/server.ts, con el mismo patrón de auth `x-api-key === M2M_API_KEY` que el
 * resto de /internal/*.
 */

import { z } from 'zod';
import { Pool } from 'pg';

export interface PartnerLicenseRow {
  contract_id: string;
  tenant_id: string;
  partner_id: string;
  package_id: string;
  version: number;
  systems: string[];
  altitude_max: number;
  modules: string[];
  valid_from: string;
  valid_until: string;
  status: 'active' | 'suspended' | 'terminated' | 'expired';
}

/**
 * INSERT ... ON CONFLICT (contract_id) DO UPDATE de todas las columnas + synced_at = now().
 * Idempotente: mismo contract_id nunca duplica fila (mismo patrón de upsert que el resto del
 * compiler — ver okf_partner_concepts UNIQUE (package_id, path) en indexing/indexer.ts).
 */
export async function upsertLicense(pool: Pool, row: PartnerLicenseRow): Promise<void> {
  await pool.query(
    `INSERT INTO kdb_partner_licenses
       (contract_id, tenant_id, partner_id, package_id, version, systems, altitude_max, modules, valid_from, valid_until, status, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (contract_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       partner_id = EXCLUDED.partner_id,
       package_id = EXCLUDED.package_id,
       version = EXCLUDED.version,
       systems = EXCLUDED.systems,
       altitude_max = EXCLUDED.altitude_max,
       modules = EXCLUDED.modules,
       valid_from = EXCLUDED.valid_from,
       valid_until = EXCLUDED.valid_until,
       status = EXCLUDED.status,
       synced_at = now()`,
    [
      row.contract_id,
      row.tenant_id,
      row.partner_id,
      row.package_id,
      row.version,
      row.systems,
      row.altitude_max,
      row.modules,
      row.valid_from,
      row.valid_until,
      row.status,
    ]
  );
}

export async function deleteLicense(pool: Pool, contract_id: string): Promise<void> {
  await pool.query('DELETE FROM kdb_partner_licenses WHERE contract_id = $1', [contract_id]);
}

const PartnerLicenseSchema = z.object({
  contract_id: z.string().uuid(),
  tenant_id: z.string().min(1),
  partner_id: z.string().uuid(),
  package_id: z.string().uuid(),
  version: z.number().int().min(1),
  systems: z.array(z.string().min(1)).min(1),
  altitude_max: z.number().int().min(1).max(5),
  modules: z.array(z.string().min(1)),
  valid_from: z.string().datetime(),
  valid_until: z.string().datetime(),
  status: z.enum(['active', 'suspended', 'terminated', 'expired']),
});

/**
 * Cross-field: action='upsert' requiere `license` (todos sus campos validados contra
 * PartnerLicenseSchema); action='delete' solo necesita `contract_id` (top-level) y NO exige
 * `license`.
 */
export const PartnerLicenseSyncInputSchema = z
  .object({
    action: z.enum(['upsert', 'delete']),
    contract_id: z.string().uuid(),
    license: PartnerLicenseSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'upsert' && !data.license) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "license es requerido cuando action='upsert'",
        path: ['license'],
      });
    }
  });

export type PartnerLicenseSyncInput = z.infer<typeof PartnerLicenseSyncInputSchema>;
