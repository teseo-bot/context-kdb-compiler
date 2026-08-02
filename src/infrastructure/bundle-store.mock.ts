import { BundleStorageBackend, ReadResult, StoredObjectMeta } from './bundle-store';

// Backend de bundle en memoria, con la misma semántica de generaciones que GcsStorageBackend
// (save falla con GENERATION_MISMATCH si ifGenerationMatch no coincide con la generación viva).
//
// USO EXCLUSIVO en tests (NODE_ENV==='test'). Prohibido como fallback en runtime — mismo
// criterio que MockEmbeddingsClient en embeddings.mock.ts: si esto se colara en producción, el
// bundle destilado se escribiría en RAM y se perdería al reiniciar el contenedor, en silencio.

export class InMemoryStorageBackend implements BundleStorageBackend {
  versions = new Map<string, { content: string; generation: bigint }[]>();
  private nextGeneration = 1n;

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
    const list = this.versions.get(path) ?? [];
    const currentGeneration = list.length > 0 ? list[list.length - 1].generation : 0n;
    if (opts?.ifGenerationMatch !== undefined && opts.ifGenerationMatch !== currentGeneration) {
      const err: any = new Error('generation mismatch');
      err.code = 'GENERATION_MISMATCH';
      throw err;
    }
    const generation = this.nextGeneration++;
    list.push({ content, generation });
    this.versions.set(path, list);
    return generation;
  }
}
