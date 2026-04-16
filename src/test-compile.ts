import { CompilerEngine } from './core/compiler-engine';

async function main() {
  const engine = new CompilerEngine();
  
  // Just validating types and basic initialization.
  // Real DB connection might fail if postgres isn't running on 5436.
  // We'll catch and log.
  try {
    console.log('Initializing DB Schema (mock/real depending on local setup)...');
    await engine.initDb();
    
    console.log('Compiling sample document...');
    const markdown = `
# Welcome to CRM Agentico
This is a sample document. It contains some text. We want to ensure it is chunked semantically.
A semantic chunker looks at sentence embeddings.
By calculating the cosine similarity, it finds topical boundaries.
    
## Section 2
This is the second section. It talks about something completely different!
Turtles are reptiles of the order Testudines. They have a shell developed mainly from their ribs.
Let's see if this works.
    `.trim();

    const result = await engine.compile(markdown, { title: 'Test Document', source: 'test-compile.ts' });
    console.log('Compilation Result:', result);
  } catch (error) {
    console.error('Error during test-compile (Expected if DB is missing on port 5436):', error);
  } finally {
    await engine.close();
  }
}

main().catch(console.error);