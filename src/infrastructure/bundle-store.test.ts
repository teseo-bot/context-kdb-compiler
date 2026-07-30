import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { BundleStore, BundleStorageBackend, GenerationMismatchError, ReadResult, StoredObjectMeta } from './bundle-store';

// K2-W1: GCS simulado en memoria — Map path -> versiones (cada versión = { content, generation }).
// `save` respeta ifGenerationMatch para poder probar concurrencia optimista.
class InMemoryStorageBackend implements BundleStorageBackend {
  versions = new Map<string, { content: string; generation: bigint }[]>();
  private nextGeneration = 1n;

  // Hook de test: si se define, se invoca en el primer save() sobre `failOncePath` y fuerza
  // un GenerationMismatchError, simulando que otro escritor ganó la carrera.
  failOncePath: string | null = null;
  private failedOnce = false;
  onRetry?: () => void;

  async read(path: string): Promise<ReadResult | null> {
    const list = this.versions.get(path);
    if (!list || list.length === 0) return null;
    const latest = list[list.length - 1];
    return { content: latest.content, generation: latest.generation };
  }

  async list(prefix: string): Promise<StoredObjectMeta[]> {
    const out: StoredObjectMeta[] = [];
    for (const [path, list] of this.versions.entries()) {
      if (path.startsWith(prefix) && list.length > 0) {
        out.push({ path, generation: list[list.length - 1].generation });
      }
    }
    return out;
  }

  async save(path: string, content: string, opts?: { ifGenerationMatch?: bigint }): Promise<bigint> {
    if (this.failOncePath === path && !this.failedOnce) {
      this.failedOnce = true;
      this.onRetry?.();
      throw new GenerationMismatchError(path);
    }

    const list = this.versions.get(path) ?? [];
    const currentGeneration = list.length > 0 ? list[list.length - 1].generation : 0n;

    if (opts?.ifGenerationMatch !== undefined && opts.ifGenerationMatch !== currentGeneration) {
      throw new GenerationMismatchError(path);
    }

    const generation = this.nextGeneration++;
    list.push({ content, generation });
    this.versions.set(path, list);
    return generation;
  }

  // Helper de test: altera directamente una línea del log ya escrito (para el caso 3).
  corruptLogLine(lineIndex: number, replacement: string) {
    const list = this.versions.get('log.md');
    if (!list || list.length === 0) throw new Error('log.md vacío en el mock');
    const latest = list[list.length - 1];
    const lines = latest.content.split('\n').filter((l) => l.length > 0);
    lines[lineIndex] = replacement;
    latest.content = lines.join('\n') + '\n';
  }
}

const VALID_FRONTMATTER = `---
type: Insight
title: "Objeciones de precio"
description: "Resumen de objeciones de precio en sector salud"
tags: [c-comercial, precio]
timestamp: 2026-07-01T10:00:00.000Z
sources: [conv:thread-1]
confidence: draft
pii: clean
altitude: 2
---
Cuerpo del concepto.
`;

const INVALID_FRONTMATTER_NO_ALTITUDE = `---
type: Insight
title: "Objeciones de precio"
description: "Resumen de objeciones de precio en sector salud"
tags: [c-comercial, precio]
timestamp: 2026-07-01T10:00:00.000Z
sources: [conv:thread-1]
confidence: draft
pii: clean
---
Cuerpo del concepto.
`;

function makeStore(backend = new InMemoryStorageBackend()) {
  const store = new BundleStore({ tenantId: 'acme', storage: backend });
  return { store, backend };
}

test('write de concepto con frontmatter inválido (sin altitude) lanza ZodError', async () => {
  const { store } = makeStore();
  await assert.rejects(
    store.write('c-comercial/objeciones-precio.md', INVALID_FRONTMATTER_NO_ALTITUDE, {
      actor: 'compiler-v2',
      accion: 'draft',
    }),
    ZodError
  );
});

test('write de draft en _staging con frontmatter inválido también lanza ZodError (SÍ se valida)', async () => {
  const { store } = makeStore();
  await assert.rejects(
    store.write('_staging/2026-07-01/draft-1.md', INVALID_FRONTMATTER_NO_ALTITUDE, {
      actor: 'compiler-v2',
      accion: 'draft',
    }),
    ZodError
  );
});

test('write de log.md/index.md/registro-fuentes.md NO valida frontmatter', async () => {
  const { store } = makeStore();
  // Ninguno de estos tiene frontmatter válido de concepto; no debe lanzar.
  await store.write('index.md', '# Sistema\n\nSin conceptos aún.', {
    actor: 'compiler-v2',
    accion: 'index-regen',
  });
  await store.write('_fuentes/registro-fuentes.md', '# Fuentes\n', {
    actor: 'compiler-v2',
    accion: 'draft',
  });
  // No hay assert de excepción: si llega aquí sin throw, el test pasa.
  assert.ok(true);
});

test('tras 3 writes válidos, verifyChain().ok === true', async () => {
  const { store } = makeStore();
  await store.write('c-comercial/concepto-1.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });
  await store.write('c-comercial/concepto-2.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });
  await store.write('c-comercial/concepto-3.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });

  const result = await store.verifyChain();
  assert.equal(result.ok, true);
  assert.equal(result.brokenAt, undefined);

  const log = await store.read('log.md');
  const lines = log!.content.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /prev:genesis$/);
});

test('alterar una línea intermedia del log simulado hace que verifyChain() devuelva ok:false y brokenAt correcto', async () => {
  const { store, backend } = makeStore();
  await store.write('c-comercial/concepto-1.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });
  await store.write('c-comercial/concepto-2.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });
  await store.write('c-comercial/concepto-3.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });

  // Corrompemos la línea del índice 1 (segunda entrada): esto rompe el prev que la línea 2
  // (índice 2) espera, por lo que la ruptura se detecta al llegar al índice 2.
  const logVersions = backend.versions.get('log.md')!;
  const latestLogContent = logVersions[logVersions.length - 1].content;
  const originalLine1 = latestLogContent.split('\n').filter((l) => l.length > 0)[1];
  backend.corruptLogLine(1, originalLine1.replace('draft', 'merge-update'));

  const result = await store.verifyChain();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
});

test('write concurrente sobre log.md: el mock rechaza la primera vez por generation desactualizada y la clase reintenta con éxito', async () => {
  const { store, backend } = makeStore();
  backend.failOncePath = 'log.md';
  let retried = false;
  backend.onRetry = () => {
    retried = true;
  };

  await store.write('c-comercial/concepto-1.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });

  assert.equal(retried, true);
  const result = await store.verifyChain();
  assert.equal(result.ok, true);
  const log = await store.read('log.md');
  const lines = log!.content.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
});

test('appendLog agota reintentos y propaga el error si el conflicto de generación persiste', async () => {
  const { store, backend } = makeStore();
  const originalSave = backend.save.bind(backend);
  let saveCalls = 0;
  backend.save = async (path, content, opts) => {
    if (path === 'log.md') {
      saveCalls++;
      throw new GenerationMismatchError(path);
    }
    return originalSave(path, content, opts);
  };

  await assert.rejects(
    store.write('c-comercial/concepto-1.md', VALID_FRONTMATTER, {
      actor: 'compiler-v2',
      accion: 'draft',
    }),
    GenerationMismatchError
  );
  assert.equal(saveCalls, 3);
});

test('read devuelve null para un path inexistente', async () => {
  const { store } = makeStore();
  const result = await store.read('no-existe.md');
  assert.equal(result, null);
});

test('list filtra por prefijo', async () => {
  const { store } = makeStore();
  await store.write('c-comercial/concepto-1.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });
  await store.write('o-operaciones/concepto-2.md', VALID_FRONTMATTER, {
    actor: 'compiler-v2',
    accion: 'draft',
  });

  const results = await store.list('c-comercial/');
  assert.equal(results.length, 1);
  assert.equal(results[0].path, 'c-comercial/concepto-1.md');
});

test('BundleStore no expone método delete', () => {
  const { store } = makeStore();
  assert.equal((store as any).delete, undefined);
});

test('bucket name usa GCS_BUNDLE_PREFIX del entorno', () => {
  const prevPrefix = process.env.GCS_BUNDLE_PREFIX;
  try {
    delete process.env.GCS_BUNDLE_PREFIX;
    const { store } = makeStore();
    assert.equal(store.bucketName, 'kdb-acme');

    process.env.GCS_BUNDLE_PREFIX = 'custom-';
    const store2 = new BundleStore({ tenantId: 'acme', storage: new InMemoryStorageBackend() });
    assert.equal(store2.bucketName, 'custom-acme');
  } finally {
    if (prevPrefix === undefined) delete process.env.GCS_BUNDLE_PREFIX;
    else process.env.GCS_BUNDLE_PREFIX = prevPrefix;
  }
});

// Regresión: con kind ausente los bundles de aliado caían en `kdb-<partner_id>`, un bucket
// que el aprovisionamiento nunca crea (crea `kdb-partner-<partner_id>`). GCS devolvía 404
// y el portal de aliados lo mostraba como el 502 al subir fuente.
test('kind partner usa GCS_PARTNER_BUNDLE_PREFIX, no el de tenant', () => {
  const prevTenant = process.env.GCS_BUNDLE_PREFIX;
  const prevPartner = process.env.GCS_PARTNER_BUNDLE_PREFIX;
  try {
    delete process.env.GCS_BUNDLE_PREFIX;
    delete process.env.GCS_PARTNER_BUNDLE_PREFIX;

    const partner = new BundleStore({
      tenantId: 'acme',
      kind: 'partner',
      storage: new InMemoryStorageBackend(),
    });
    assert.equal(partner.bucketName, 'kdb-partner-acme');

    const tenant = new BundleStore({
      tenantId: 'acme',
      kind: 'tenant',
      storage: new InMemoryStorageBackend(),
    });
    assert.equal(tenant.bucketName, 'kdb-acme');

    // El prefijo de tenant no debe arrastrar al de aliado.
    process.env.GCS_BUNDLE_PREFIX = 'custom-';
    const partner2 = new BundleStore({
      tenantId: 'acme',
      kind: 'partner',
      storage: new InMemoryStorageBackend(),
    });
    assert.equal(partner2.bucketName, 'kdb-partner-acme');

    process.env.GCS_PARTNER_BUNDLE_PREFIX = 'socios-';
    const partner3 = new BundleStore({
      tenantId: 'acme',
      kind: 'partner',
      storage: new InMemoryStorageBackend(),
    });
    assert.equal(partner3.bucketName, 'socios-acme');
  } finally {
    if (prevTenant === undefined) delete process.env.GCS_BUNDLE_PREFIX;
    else process.env.GCS_BUNDLE_PREFIX = prevTenant;
    if (prevPartner === undefined) delete process.env.GCS_PARTNER_BUNDLE_PREFIX;
    else process.env.GCS_PARTNER_BUNDLE_PREFIX = prevPartner;
  }
});
