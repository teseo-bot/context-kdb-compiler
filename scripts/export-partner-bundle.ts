#!/usr/bin/env npx tsx

/**
 * PA6-W3b: Export de offboarding del bundle de un aliado [INV-8.2]
 *
 * Al terminar la relación con un aliado, se le entrega su bundle GCS COMPLETO (todo lo que hay
 * en su bucket vivo: index.md, log.md, _staging/**, paquetes/**) como un tar.gz determinista vía
 * una URL firmada V4 temporal, subido a un bucket de ENTREGA separado (nunca el bucket vivo del
 * bundle). Tras la subida se dejan un recibo de no-repudio en la cadena de custodia del propio
 * bundle (`_exports/{ts}-receipt.json`, vía `BundleStore.write`, que sigue apendeando a log.md)
 * — el recibo prueba que la entrega ocurrió, y queda FUERA del tar (se escribe después de
 * empaquetar) para que el tar refleje fielmente el estado pre-export.
 *
 * Gate central [INV-8.2]: si `store.verifyChain()` reporta la cadena rota, el export se ABORTA
 * por completo — nunca se entrega a un aliado un bundle cuya integridad no se puede verificar.
 *
 * La lógica reutilizable vive en `exportPartnerBundle(deps)` (mismo patrón que `runSeed` de
 * scripts/seed-partner-demo.ts): recibe todas sus dependencias inyectadas (store, storage,
 * uploader, signUrl, now, nonce) para que `src/partners/export-partner-bundle.test.ts` la
 * ejecute con infra en memoria, y `main()` (abajo) la ejecute contra infra real (GCS real vía
 * `GcsRealBackend`, reexportado de scripts/seed-partner-demo.ts).
 *
 * Uso:
 *   npx tsx scripts/export-partner-bundle.ts [--partner-id=<uuid>] [--partner-slug=<slug>]
 *   (defaults: DEMO_PARTNER_ID / DEMO_PARTNER_SLUG del aliado demo)
 */

import { createHash, randomBytes } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { BundleStore, BundleStorageBackend } from '../src/infrastructure/bundle-store';
import { packTarGz, TarEntry } from '../src/partners/tar-pack';
import { GcsRealBackend, DEMO_PARTNER_ID, DEMO_PARTNER_SLUG } from './seed-partner-demo';

// ==================== Núcleo testeable ====================

export interface ExportDeps {
  store: BundleStore; // del aliado (tenantId = partner_id)
  storage: BundleStorageBackend; // backend crudo subyacente (MISMO objeto que usa `store`)
  partnerId: string;
  partnerSlug: string;
  uploader: (objectPath: string, data: Buffer) => Promise<void>; // sube al bucket de ENTREGA
  signUrl: (objectPath: string, expiresAtMs: number) => Promise<string>; // URL firmada V4
  now?: () => Date; // inyectable para test
  nonce?: () => string; // inyectable para test (default: crypto.randomBytes(8).toString('hex'))
  ttlHours?: number; // default: Number(process.env.EXPORT_URL_TTL_HOURS ?? 72)
}

export interface ExportResult {
  objectPath: string; // '{partnerSlug}/{yyyymmddThhmmssZ}-{nonce}.tar.gz'
  sha256: string; // hex del tar.gz
  fileCount: number;
  signedUrl: string;
  expiresAt: string; // ISO
  receiptPath: string; // path del recibo escrito en el bundle
}

/**
 * Formatea una fecha en el formato compacto UTC usado en el nombre del objeto de entrega:
 * YYYYMMDDTHHMMSSZ (sin separadores, sin milisegundos).
 */
function formatTimestampCompact(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Ejecuta el export completo de offboarding de un aliado (orden IMPORTA):
 *   1. Gate de integridad: `store.verifyChain()` — cadena rota ⇒ abort total [INV-8.2].
 *   2. Recolecta el bundle COMPLETO (`storage.list('')` + `storage.read()` por objeto), sin
 *      exclusiones. Bundle inexistente (0 objetos) ⇒ error (no un export vacío silencioso).
 *   3. Empaqueta determinista (`packTarGz`, mtime fijo) + sha256 hex del tar.gz.
 *   4. Sube al bucket de ENTREGA (nunca el bucket vivo del bundle).
 *   5. Genera URL firmada V4 con TTL configurable.
 *   6. Escribe un recibo de no-repudio en la cadena de custodia del bundle ORIGINAL
 *      (`_exports/{ts}-receipt.json`), DESPUÉS de subir — queda fuera del tar.
 */
export async function exportPartnerBundle(deps: ExportDeps): Promise<ExportResult> {
  const now = deps.now ?? (() => new Date());
  const nonce = deps.nonce ?? (() => randomBytes(8).toString('hex'));
  const ttlHours = deps.ttlHours ?? Number(process.env.EXPORT_URL_TTL_HOURS ?? 72);

  // 1. Gate de integridad [INV-8.2]: NUNCA exportar con cadena rota.
  const chain = await deps.store.verifyChain();
  if (!chain.ok) {
    throw new Error(
      `EXPORT BLOQUEADO: hash-chain rota en línea ${chain.brokenAt} — no se exporta un bundle sin integridad verificable`
    );
  }

  // 2. Recolectar bundle COMPLETO, sin exclusiones.
  const objects = await deps.storage.list('');
  if (objects.length === 0) {
    throw new Error(
      `export-partner-bundle: el bundle del aliado ${deps.partnerId} no tiene ningún objeto — bundle inexistente, no se exporta un tar vacío`
    );
  }

  const entries: TarEntry[] = [];
  for (const obj of objects) {
    const read = await deps.storage.read(obj.path);
    if (!read) {
      throw new Error(`export-partner-bundle: objeto listado pero ilegible: ${obj.path}`);
    }
    entries.push({ path: obj.path, content: read.content });
  }

  // 3. Empaquetar determinista + sha256 del tar.gz.
  const buf = packTarGz(entries);
  const sha256 = createHash('sha256').update(buf).digest('hex');

  // 4. Subir al bucket de ENTREGA (nunca el bucket vivo del bundle).
  const ts = formatTimestampCompact(now());
  const objectPath = `${deps.partnerSlug}/${ts}-${nonce()}.tar.gz`;
  await deps.uploader(objectPath, buf);

  // 5. URL firmada V4 con expiración.
  const expiresAtMs = now().getTime() + ttlHours * 3600_000;
  const signedUrl = await deps.signUrl(objectPath, expiresAtMs);
  const expiresAt = new Date(expiresAtMs).toISOString();

  // 6. Recibo de no-repudio en la cadena de custodia (fuera del tar; se escribe DESPUÉS de subir).
  const receiptPath = `_exports/${ts}-receipt.json`;
  const receiptBody = {
    exported_at: now().toISOString(),
    partner_id: deps.partnerId,
    partner_slug: deps.partnerSlug,
    object_path: objectPath,
    sha256,
    file_count: entries.length,
    expires_at: expiresAt,
  };
  await deps.store.write(receiptPath, JSON.stringify(receiptBody, null, 2), {
    actor: 'export-offboarding',
    accion: 'mirror',
  });

  const result: ExportResult = {
    objectPath,
    sha256,
    fileCount: entries.length,
    signedUrl,
    expiresAt,
    receiptPath,
  };

  console.log('[export-partner-bundle] object_path:', result.objectPath);
  console.log('[export-partner-bundle] sha256:', result.sha256);
  console.log('[export-partner-bundle] file_count:', result.fileCount);
  console.log('[export-partner-bundle] expires_at:', result.expiresAt);
  console.log('[export-partner-bundle] signed_url:', result.signedUrl);
  console.log('[export-partner-bundle] receipt_path:', result.receiptPath);

  return result;
}

// ==================== main(): wiring REAL (GCS real) ====================

function parseArgs(argv: string[]): { partnerId: string; partnerSlug: string } {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return {
    partnerId: args['partner-id'] ?? DEMO_PARTNER_ID,
    partnerSlug: args['partner-slug'] ?? DEMO_PARTNER_SLUG,
  };
}

/**
 * Crea el bucket de entrega si no existe. Minimización de datos: los datos del aliado no se
 * quedan en nuestra entrega para siempre — lifecycle rule de auto-borrado a 30 días.
 */
async function ensureExportBucket(bucketName: string): Promise<void> {
  const storage = new Storage();
  const [exists] = await storage.bucket(bucketName).exists();
  if (exists) {
    console.log(`[export-partner-bundle] Bucket de entrega ${bucketName} ya existe, continuando...`);
    return;
  }
  console.log(`[export-partner-bundle] Creando bucket de entrega ${bucketName}...`);
  await storage.createBucket(bucketName, {
    uniformBucketLevelAccess: { enabled: true },
    publicAccessPrevention: 'enforced',
    lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 30 } }] },
  } as any);
  console.log(
    `[export-partner-bundle] Bucket de entrega ${bucketName} creado (lifecycle: auto-borrado a 30 días)`
  );
}

async function main(): Promise<void> {
  const { partnerId, partnerSlug } = parseArgs(process.argv.slice(2));

  const bundleBucketName = `${process.env.GCS_PARTNER_BUNDLE_PREFIX ?? 'kdb-partner-'}${partnerId}`;
  const exportBucketName = process.env.GCS_PARTNER_EXPORT_BUCKET ?? 'kdb-partner-exports';

  try {
    await ensureExportBucket(exportBucketName);

    const bundleBackend = new GcsRealBackend(bundleBucketName);
    const store = new BundleStore({ tenantId: partnerId, storage: bundleBackend });

    const storageClient = new Storage();
    const exportBucket = storageClient.bucket(exportBucketName);

    const uploader = async (objectPath: string, data: Buffer): Promise<void> => {
      await exportBucket.file(objectPath).save(data, { resumable: false });
    };

    const signUrl = async (objectPath: string, expiresAtMs: number): Promise<string> => {
      try {
        const [url] = await exportBucket.file(objectPath).getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: expiresAtMs,
        });
        return url;
      } catch (error) {
        // ADC local sin signBlob no puede firmar V4 — el export YA subió, solo la URL no se pudo
        // firmar. Degradar con warning claro imprimiendo el gs:// path en vez de reventar todo
        // el offboarding.
        console.warn(
          `[export-partner-bundle] AVISO: no se pudo firmar la URL (credenciales locales sin signBlob). ` +
            `El bundle YA se subió a gs://${exportBucketName}/${objectPath}`,
          error
        );
        return `(sin firmar — gs://${exportBucketName}/${objectPath})`;
      }
    };

    const result = await exportPartnerBundle({
      store,
      storage: bundleBackend,
      partnerId,
      partnerSlug,
      uploader,
      signUrl,
    });

    console.log('[export-partner-bundle] OK', result);
  } catch (error) {
    console.error('[export-partner-bundle] Error durante el export:', error);
    process.exit(1);
  }
}

// Solo ejecutar main() si se llama directamente (no en import, p.ej. desde el test).
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
