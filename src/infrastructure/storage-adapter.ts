import { Storage } from '@google-cloud/storage';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface StorageAdapter {
  readMarkdown(uriOrPath: string): Promise<string>;
  upload(bucketName: string, fileName: string, content: string | Buffer, contentType?: string): Promise<string>;
}

export class GcsStorageAdapter implements StorageAdapter {
  private storage: Storage;

  constructor() {
    this.storage = new Storage();
  }

  /**
   * Reads a markdown file from a Google Cloud Storage bucket.
   * Expected format for uriOrPath: "gs://bucket-name/path/to/file.md"
   * Or it could be just "bucket-name/path/to/file.md" depending on how it's passed.
   * If passing bucket and file name directly, consider a different method or parsing the URI.
   */
  async readMarkdown(uriOrPath: string): Promise<string> {
    // Parse gs:// URI
    const match = uriOrPath.match(/^gs:\/\/([^\/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid GCS URI format: ${uriOrPath}. Expected gs://bucket-name/file-path`);
    }

    const bucketName = match[1];
    const fileName = match[2];

    const file = this.storage.bucket(bucketName).file(fileName);
    const [contents] = await file.download();
    return contents.toString('utf-8');
  }

  /**
   * Helper method to read directly from bucket and name
   */
  async readFromBucket(bucketName: string, fileName: string): Promise<string> {
    const file = this.storage.bucket(bucketName).file(fileName);
    const [contents] = await file.download();
    return contents.toString('utf-8');
  }

  /**
   * Upload content to the GCS Bucket.
   */
  async upload(bucketName: string, fileName: string, content: string | Buffer, contentType: string = 'text/markdown'): Promise<string> {
    const file = this.storage.bucket(bucketName).file(fileName);
    await file.save(content, {
      contentType,
      resumable: false,
    });
    return `gs://${bucketName}/${fileName}`;
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ? path.resolve(baseDir) : path.resolve(process.cwd(), 'storage');
  }

  async readMarkdown(uriOrPath: string): Promise<string> {
    const resolvedPath = path.resolve(this.baseDir, uriOrPath);
    if (!resolvedPath.startsWith(this.baseDir)) {
      throw new Error('Security Violation: Path traversal detected');
    }
    const content = await fs.readFile(resolvedPath, 'utf-8');
    return content;
  }

  async upload(bucketName: string, fileName: string, content: string | Buffer, contentType: string = 'text/markdown'): Promise<string> {
    const filePath = path.resolve(this.baseDir, bucketName, fileName);
    if (!filePath.startsWith(this.baseDir)) {
      throw new Error('Security Violation: Path traversal detected on upload');
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    return filePath;
  }
}
