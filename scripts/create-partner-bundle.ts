#!/usr/bin/env npx tsx

/**
 * PA2-W1: Script de onboarding de bundle del aliado
 *
 * Uso: npx tsx scripts/create-partner-bundle.ts --partner-id=<id>
 * Crea bucket GCS, escribe esqueleto de bundle (index.md, log.md genesis, _staging/.keep).
 */

import { Storage } from '@google-cloud/storage';
import { createPartnerBundleWithStorage, validatePartnerId } from '../src/partners/bundle';
import { BundleStore } from '../src/infrastructure/bundle-store';

/**
 * Adaptador real sobre @google-cloud/storage, sin precondición de versioning
 * en bucket. La creación del bucket se maneja aparte con versioning ON.
 */
class GcsRealBackendPartner {
  private storage: Storage;
  private bucketName: string;

  constructor(bucketName: string) {
    this.storage = new Storage();
    this.bucketName = bucketName;
  }

  async read(path: string) {
    const file = this.storage.bucket(this.bucketName).file(path);
    try {
      const [buf] = await file.download();
      const [metadata] = await file.getMetadata();
      const generation = BigInt(metadata.generation ?? 0);
      return { content: buf.toString('utf8'), generation };
    } catch (error: any) {
      if (error?.code === 404) return null;
      throw error;
    }
  }

  async list(prefix: string) {
    const [files] = await this.storage.bucket(this.bucketName).getFiles({ prefix });
    return files.map((f) => ({
      path: f.name,
      generation: BigInt(f.metadata.generation ?? 0),
    }));
  }

  async save(path: string, content: string, opts?: { ifGenerationMatch?: bigint }) {
    const file = this.storage.bucket(this.bucketName).file(path);
    try {
      await file.save(content, {
        resumable: false,
        preconditionOpts:
          opts?.ifGenerationMatch !== undefined
            ? { ifGenerationMatch: opts.ifGenerationMatch.toString() }
            : undefined,
      });
      const [metadata] = await file.getMetadata();
      return BigInt(metadata.generation ?? 0);
    } catch (error: any) {
      if (error?.code === 412) {
        const err = new Error(`Generation mismatch al escribir ${path}`);
        (err as any).code = 'GENERATION_MISMATCH';
        throw err;
      }
      throw error;
    }
  }
}

/**
 * Crea el bucket GCS con versioning ON, UBLA ON, labels partner
 */
async function createBucketPartner(partnerId: string, bucketName: string): Promise<boolean> {
  const storage = new Storage();

  try {
    const [exists] = await storage.bucket(bucketName).exists();
    if (exists) {
      console.log(`[partner-onboarding] Bucket ${bucketName} ya existe, continuando...`);
      return true;
    }

    console.log(`[partner-onboarding] Creando bucket ${bucketName} en region us-central1...`);
    const [bucket] = await storage.createBucket(bucketName, {
      location: 'us-central1',
      labels: { partner: partnerId },
      versioning: { enabled: true },
      uniformBucketLevelAccess: { enabled: true },
    });
    console.log(`[partner-onboarding] Bucket ${bucketName} creado exitosamente`);
    return true;
  } catch (error) {
    console.error(`[partner-onboarding] Error al crear/verificar bucket ${bucketName}:`, error);
    throw error;
  }
}

/**
 * CLI principal
 */
async function main() {
  const args = process.argv.slice(2);
  const partnerMatch = args.find((a) => a.startsWith('--partner-id='));

  if (!partnerMatch) {
    console.error('Uso: npx tsx scripts/create-partner-bundle.ts --partner-id=<id>');
    console.error('Ejemplo: npx tsx scripts/create-partner-bundle.ts --partner-id=550e8400-e29b-41d4-a716-446655440000');
    process.exit(1);
  }

  const partnerId = partnerMatch.split('=')[1];

  if (!validatePartnerId(partnerId)) {
    console.error(
      `Error: partner ID inválido '${partnerId}'. Debe ser UUID.`
    );
    process.exit(1);
  }

  const bucketName = `${process.env.GCS_PARTNER_BUNDLE_PREFIX ?? 'kdb-partner-'}${partnerId}`;

  try {
    console.log(`[partner-onboarding] Iniciando creación de bundle para partner: ${partnerId}`);
    console.log(`[partner-onboarding] Bucket destino: ${bucketName}`);

    // Crear bucket con versioning ON, UBLA ON
    await createBucketPartner(partnerId, bucketName);

    // Escribir esqueleto
    const backend = new GcsRealBackendPartner(bucketName);
    const result = await createPartnerBundleWithStorage(partnerId, backend);

    // Reportar éxito
    console.log(`[partner-onboarding] Bundle creado exitosamente`);
    console.log(`[partner-onboarding] Archivos escritos: ${result.fileCount}`);
    console.log(`[partner-onboarding] Verificación de hash-chain: PASSED`);
    console.log(`[partner-onboarding] Bucket: ${bucketName}`);
  } catch (error) {
    console.error('[partner-onboarding] Error durante creación de bundle:', error);
    process.exit(1);
  }
}

// Solo ejecutar main() si se llama directamente (no en import)
if (require.main === module || process.argv[1]?.endsWith('create-partner-bundle.ts')) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

  const partnerId = partnerMatch.split('=')[1];

  if (!validatePartnerId(partnerId)) {
    console.error(
      `Error: partner ID inválido '${partnerId}'. Debe ser UUID.`
    );
    process.exit(1);
  }

  const bucketName = `${process.env.GCS_PARTNER_BUNDLE_PREFIX ?? 'kdb-partner-'}${partnerId}`;

  try {
    console.log(`[partner-onboarding] Iniciando creación de bundle para partner: ${partnerId}`);
    console.log(`[partner-onboarding] Bucket destino: ${bucketName}`);

    // Crear bucket con versioning ON, UBLA ON
    await createBucketPartner(partnerId, bucketName);

    // Escribir esqueleto
    const backend = new GcsRealBackendPartner(bucketName);
    const store = new BundleStore({ tenantId: partnerId, storage: backend });
    const fileCount = await writePartnerBundle(store);

    // Verificar hash-chain
    const verification = await store.verifyChain();
    if (!verification.ok) {
      console.error(
        `[partner-onboarding] ERROR: Hash-chain roto en línea ${verification.brokenAt}`
      );
      process.exit(1);
    }

    // Reportar éxito
    console.log(`[partner-onboarding] Bundle creado exitosamente`);
    console.log(`[partner-onboarding] Archivos escritos: ${fileCount}`);
    console.log(`[partner-onboarding] Verificación de hash-chain: PASSED`);
    console.log(`[partner-onboarding] Bucket: ${bucketName}`);
  } catch (error) {
    console.error('[partner-onboarding] Error durante creación de bundle:', error);
    process.exit(1);
  }
}

// Solo ejecutar main() si se llama directamente (no en import)
if (require.main === module || process.argv[1]?.endsWith('create-partner-bundle.ts')) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { InMemoryStorageBackendForPartnerScript };
