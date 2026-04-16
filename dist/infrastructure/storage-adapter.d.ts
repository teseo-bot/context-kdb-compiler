export interface StorageAdapter {
    readMarkdown(uriOrPath: string): Promise<string>;
}
export declare class GcsStorageAdapter implements StorageAdapter {
    private storage;
    constructor();
    /**
     * Reads a markdown file from a Google Cloud Storage bucket.
     * Expected format for uriOrPath: "gs://bucket-name/path/to/file.md"
     * Or it could be just "bucket-name/path/to/file.md" depending on how it's passed.
     * If passing bucket and file name directly, consider a different method or parsing the URI.
     */
    readMarkdown(uriOrPath: string): Promise<string>;
    /**
     * Helper method to read directly from bucket and name
     */
    readFromBucket(bucketName: string, fileName: string): Promise<string>;
}
export declare class LocalStorageAdapter implements StorageAdapter {
    readMarkdown(uriOrPath: string): Promise<string>;
}
//# sourceMappingURL=storage-adapter.d.ts.map