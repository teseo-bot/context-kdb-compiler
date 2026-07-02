// Harness E2E K8 — backend de almacenamiento sobre sistema de archivos.
// Reemplaza GCS para correr el E2E local sin credenciales. El bundle queda
// inspeccionable en disco. Implementa BundleStorageBackend (misma interfaz que
// GcsStorageBackend). `generation` = mtime en nanosegundos (bigint), monótono por
// escritura, compatible con la detección de cambios de indexDelta.
import { promises as fs, statSync } from 'fs';
import * as path from 'path';

export interface ReadResult {
  content: string;
  generation: bigint;
}
export interface StoredObjectMeta {
  path: string;
  generation: bigint;
}

export class FsStorageBackend {
  constructor(private root: string) {}

  private full(p: string): string {
    return path.join(this.root, p);
  }

  async read(p: string): Promise<ReadResult | null> {
    try {
      const content = await fs.readFile(this.full(p), 'utf8');
      const st = statSync(this.full(p), { bigint: true });
      return { content, generation: st.mtimeNs };
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<StoredObjectMeta[]> {
    const out: StoredObjectMeta[] = [];
    const root = this.root;
    async function walk(dir: string, rel: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e: any) {
        if (e?.code === 'ENOENT') return;
        throw e;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(abs, r);
        } else {
          const st = statSync(abs, { bigint: true });
          out.push({ path: r, generation: st.mtimeNs });
        }
      }
    }
    await walk(root, '');
    return out.filter((o) => o.path.startsWith(prefix));
  }

  async save(
    p: string,
    content: string,
    opts?: { ifGenerationMatch?: bigint }
  ): Promise<bigint> {
    if (opts?.ifGenerationMatch !== undefined) {
      const cur = await this.read(p);
      const curGen = cur ? cur.generation : 0n;
      if (curGen !== opts.ifGenerationMatch) {
        const err: any = new Error(`Generation mismatch al escribir ${p}`);
        err.code = 'GENERATION_MISMATCH';
        throw err;
      }
    }
    await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
    await fs.writeFile(this.full(p), content, 'utf8');
    const st = statSync(this.full(p), { bigint: true });
    return st.mtimeNs;
  }
}

// Cliente LLM sobre Ollama local. Satisface DistillerLlm y ModelClient (ambos
// exponen generate(prompt): Promise<string>).
export class OllamaLLM {
  // jsonMode fuerza salida JSON válida a nivel de transporte (Ollama format:'json').
  // Úsalo para el distiller V2 (que exige JSON); NO para V3 consolidate (que exige markdown).
  constructor(
    private model = process.env.E2E_OLLAMA_MODEL ?? 'gemma4:12b',
    private host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    private jsonMode = false
  ) {}

  async generate(prompt: string): Promise<string> {
    const body: any = { model: this.model, prompt, stream: false };
    if (this.jsonMode) body.format = 'json';
    const r = await fetch(`${this.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Ollama API error: ${r.status} ${r.statusText}`);
    const j: any = await r.json();
    return j.response ?? '';
  }
}

// PiiLlm no-op: la pasada regex (determinista) sí corre; la pasada LLM se omite.
export class NoopPiiLlm {
  async detectSpans(): Promise<{ start: number; end: number; type: 'PERSONA' | 'DIRECCION' }[]> {
    return [];
  }
}
