/**
 * Semantic Text Chunker
 */
import { type TextChunk } from './recursive-chunker';
export interface SemanticChunkOptions {
    chunkSize?: number;
    chunkOverlap?: number;
    embedFn?: (texts: string[]) => Promise<number[][]>;
}
export declare function chunkTextSemantic(text: string, opts: SemanticChunkOptions): Promise<TextChunk[]>;
export declare function splitSentences(text: string): string[];
//# sourceMappingURL=semantic-chunker.d.ts.map