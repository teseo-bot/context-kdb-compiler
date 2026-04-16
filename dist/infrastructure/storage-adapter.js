"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalStorageAdapter = exports.GcsStorageAdapter = void 0;
const storage_1 = require("@google-cloud/storage");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
class GcsStorageAdapter {
    storage;
    constructor() {
        this.storage = new storage_1.Storage();
    }
    /**
     * Reads a markdown file from a Google Cloud Storage bucket.
     * Expected format for uriOrPath: "gs://bucket-name/path/to/file.md"
     * Or it could be just "bucket-name/path/to/file.md" depending on how it's passed.
     * If passing bucket and file name directly, consider a different method or parsing the URI.
     */
    async readMarkdown(uriOrPath) {
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
    async readFromBucket(bucketName, fileName) {
        const file = this.storage.bucket(bucketName).file(fileName);
        const [contents] = await file.download();
        return contents.toString('utf-8');
    }
    /**
     * Upload content to the GCS Bucket.
     */
    async upload(bucketName, fileName, content, contentType = 'text/markdown') {
        const file = this.storage.bucket(bucketName).file(fileName);
        await file.save(content, {
            contentType,
            resumable: false,
        });
        return `gs://${bucketName}/${fileName}`;
    }
}
exports.GcsStorageAdapter = GcsStorageAdapter;
class LocalStorageAdapter {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir ? path.resolve(baseDir) : path.resolve(process.cwd(), 'storage');
    }
    async readMarkdown(uriOrPath) {
        const resolvedPath = path.resolve(this.baseDir, uriOrPath);
        if (!resolvedPath.startsWith(this.baseDir)) {
            throw new Error('Security Violation: Path traversal detected');
        }
        const content = await fs.readFile(resolvedPath, 'utf-8');
        return content;
    }
    async upload(bucketName, fileName, content, contentType = 'text/markdown') {
        const filePath = path.resolve(this.baseDir, bucketName, fileName);
        if (!filePath.startsWith(this.baseDir)) {
            throw new Error('Security Violation: Path traversal detected on upload');
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
        return filePath;
    }
}
exports.LocalStorageAdapter = LocalStorageAdapter;
