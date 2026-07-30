/**
 * PA2-W1: Lógica compartida para crear bundles de aliado
 * Usada por: scripts/create-partner-bundle.ts y rutas /internal/partner-bundle-create
 */

import { BundleStore } from '../infrastructure/bundle-store';

/**
 * Validación: partner_id debe ser UUID
 */
export function validatePartnerId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Escribir esqueleto del bundle vía BundleStore (TRD §2)
 * Layout: index.md, log.md (auto-generado), _staging/.keep
 */
async function writePartnerBundle(store: BundleStore): Promise<number> {
  let fileCount = 0;

  // Raíz index.md (catálogo interno vacío)
  const rootIndexBody = `# Catálogo de Conocimiento

_Sin paquetes publicados aún._`;
  await store.write('index.md', rootIndexBody, {
    actor: 'compiler-v2',
    accion: 'index-regen',
  });
  fileCount++;

  // _staging/.keep (vacío)
  await store.write('_staging/.keep', '', {
    actor: 'compiler-v2',
    accion: 'draft',
  });
  fileCount++;

  return fileCount;
}

/**
 * Crear bundle de aliado con GCS simulado o real
 * Exportable para tests
 */
export async function createPartnerBundleWithStorage(
  partnerId: string,
  storage?: any
): Promise<{ fileCount: number; verified: boolean }> {
  if (!validatePartnerId(partnerId)) {
    throw new Error(`Partner ID inválido: '${partnerId}' debe ser UUID`);
  }

  const backend = storage || ((): any => {
    throw new Error('Storage backend is required when not using GCS');
  })();
  const store = new BundleStore({ tenantId: partnerId, kind: 'partner', storage: backend });

  const fileCount = await writePartnerBundle(store);
  const verification = await store.verifyChain();

  if (!verification.ok) {
    throw new Error(
      `Hash-chain roto en línea ${verification.brokenAt}. Bundle de aliado no es válido.`
    );
  }

  return { fileCount, verified: verification.ok };
}
