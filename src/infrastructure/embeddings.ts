import { GoogleGenAI } from '@google/genai';

// K0-W1 (TRD §8): cliente de embeddings reales. Nunca degradar a mock fuera de tests.

export interface EmbeddingsClient {
  embed(texts: string[]): Promise<number[][]>; // len(out) === len(texts), dim 768
}

export const EMBEDDING_DIM = 768;
const MAX_BATCH_SIZE = 100;
const DEFAULT_RETRY_DELAYS_MS = [1000, 4000, 16000];

export class EmbeddingDimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingDimensionError';
  }
}

type BatchFn = (texts: string[]) => Promise<number[][]>;

export interface GeminiEmbeddingsOptions {
  apiKey?: string;
  model?: string;
  // Inyectables para tests (batchFn reemplaza la llamada al SDK).
  batchFn?: BatchFn;
  retryDelaysMs?: number[];
}

function isRetryable(error: any): boolean {
  const status = error?.status ?? error?.code;
  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status < 600);
  }
  return /\b(429|500|502|503|504)\b/.test(String(error?.message ?? ''));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GeminiEmbeddingsClient implements EmbeddingsClient {
  private batchFn: BatchFn;
  private retryDelaysMs: number[];

  constructor(opts?: GeminiEmbeddingsOptions) {
    this.retryDelaysMs = opts?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

    if (opts?.batchFn) {
      this.batchFn = opts.batchFn;
      return;
    }

    const model = opts?.model ?? process.env.EMBEDDINGS_MODEL ?? 'gemini-embedding-001';
    const apiKey =
      opts?.apiKey ??
      process.env.GEMINI_DIRECT_KEY ??
      process.env.GEMINI_API_KEYS?.split(',')[0] ??
      '';
    const ai = new GoogleGenAI({ apiKey });

    this.batchFn = async (texts: string[]) => {
      const response = await ai.models.embedContent({
        model,
        contents: texts,
        config: { outputDimensionality: EMBEDDING_DIM },
      });
      return (response.embeddings ?? []).map((e) => e.values ?? []);
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      out.push(...(await this.embedBatchWithRetry(batch)));
    }

    if (out.length !== texts.length) {
      throw new EmbeddingDimensionError(
        `Embeddings count mismatch: expected ${texts.length}, got ${out.length}`
      );
    }
    for (let i = 0; i < out.length; i++) {
      if (out[i].length !== EMBEDDING_DIM) {
        throw new EmbeddingDimensionError(
          `Embedding ${i} has dimension ${out[i].length}, expected ${EMBEDDING_DIM}`
        );
      }
    }
    return out;
  }

  private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
    let lastError: any;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        return await this.batchFn(batch);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.retryDelaysMs.length) {
          throw error;
        }
        await sleep(this.retryDelaysMs[attempt]);
      }
    }
    throw lastError;
  }
}
