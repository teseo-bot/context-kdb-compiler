import { EmbeddingsClient, EMBEDDING_DIM } from './embeddings';

// K0-W1: mock determinista movido de compiler-engine.ts.
// USO EXCLUSIVO en tests (NODE_ENV==='test'). Prohibido como fallback en runtime.

export class MockEmbeddingsClient implements EmbeddingsClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array(EMBEDDING_DIM).fill(0).map((_, i) => {
        return (Math.sin(text.length + i) + 1) / 2; // valores entre 0 y 1
      });
      return vector;
    });
  }
}
