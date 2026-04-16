/**
 * Recursive Delimiter-Aware Text Chunker
 */
export interface ChunkOptions {
    chunkSize?: number;
    chunkOverlap?: number;
}
export interface TextChunk {
    text: string;
    index: number;
}
export declare function chunkText(text: string, opts?: ChunkOptions): TextChunk[];
//# sourceMappingURL=recursive-chunker.d.ts.map