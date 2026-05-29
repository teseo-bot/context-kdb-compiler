import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { GcsStorageAdapter } from './infrastructure/storage-adapter';
import { CompilerEngine } from './core/compiler-engine';
import { DocumentDistiller } from './ingestion/distiller';

const app = new Hono();
const gcsAdapter = new GcsStorageAdapter();
const distiller = new DocumentDistiller();

// Initialize CompilerEngine. In production, we'd pass environment variables here.
const engine = new CompilerEngine({ dbUrl: process.env.DATABASE_URL });

// Ensure DB is initialized before starting processing
let dbInitialized = false;
async function ensureDb() {
  if (!dbInitialized) {
    await engine.initDb();
    dbInitialized = true;
  }
}

app.post('/pubsub', async (c) => {
  try {
    const body = await c.req.json();
    
    // Pub/Sub push messages are structured as:
    // { "message": { "data": "base64-encoded-string", "messageId": "..." } }
    if (!body.message || !body.message.data) {
      console.warn('Invalid Pub/Sub payload structure');
      return c.json({ error: 'Bad Request' }, 400);
    }

    const dataBuffer = Buffer.from(body.message.data, 'base64');
    const dataJson = JSON.parse(dataBuffer.toString('utf-8'));

    const bucket = dataJson.bucket;
    const name = dataJson.name;

    if (!bucket || !name) {
      console.warn('Missing bucket or name in Pub/Sub data');
      return c.text('Missing bucket or name', 400);
    }

    // Only process .md files
    if (!name.endsWith('.md')) {
      console.log(`Ignoring non-markdown file: ${name}`);
      return c.text('Ignored: not a markdown file', 200);
    }

    console.log(`Processing file: gs://${bucket}/${name}`);

    // Download content
    const markdownContent = await gcsAdapter.readFromBucket(bucket, name);

    // Ensure DB is ready
    await ensureDb();

    // Compile and store
    const result = await engine.compile(markdownContent, {
      title: name,
      source: `gs://${bucket}/${name}`,
      bucket: bucket,
      fileName: name
    });

    console.log(`Successfully compiled gs://${bucket}/${name}. Chunks: ${result.chunkCount}`);
    
    return c.text('Success', 200);

  } catch (error) {
    console.error('Error processing Pub/Sub message:', error);
    // Return 500 to trigger a retry in Pub/Sub
    return c.text('Internal Server Error', 500);
  }
});

app.post('/ingest/telegram', async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file provided in form data under "file" field' }, 400);
    }

    if (file.size > 10 * 1024 * 1024) {
      return c.json({ error: 'Payload Too Large' }, 413);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Call DocumentDistiller
    const markdown = await distiller.processBuffer(buffer, file.type, file.name);

    // Upload to GCS (mockable via adapter)
    const bucketName = process.env.GCS_BUCKET || 'telegram-ingestion-bucket';
    const timestamp = Date.now();
    const cleanName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const mdFileName = `ingested/${timestamp}-${cleanName}.md`;

    const gcsUri = await gcsAdapter.upload(bucketName, mdFileName, markdown, 'text/markdown');

    return c.json({ success: true, uri: gcsUri });
  } catch (error) {
    console.error('Error in /ingest/telegram:', error);
    return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

const port = parseInt(process.env.PORT || '8080', 10);

console.log(`Starting server on port ${port}...`);
serve({
  fetch: app.fetch,
  port
});
