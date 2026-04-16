export interface CompilerOptions {
    dbUrl?: string;
    vertexAiEndpoint?: string;
}
export interface DocumentMetadata {
    title: string;
    source?: string;
    [key: string]: any;
}
export interface CompileResult {
    documentId: number;
    hash: string;
    chunkCount: number;
}
export declare class CompilerEngine {
    private pool;
    private endpoint;
    constructor(opts?: CompilerOptions);
    initDb(): Promise<void>;
    compile(markdown: string, metadata: DocumentMetadata): Promise<CompileResult>;
    private mockEmbeddingsCall;
    close(): Promise<void>;
}
//# sourceMappingURL=compiler-engine.d.ts.map