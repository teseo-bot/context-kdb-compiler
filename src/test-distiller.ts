import { DocumentDistiller } from './ingestion/distiller';

async function runTest() {
  const distiller = new DocumentDistiller();
  
  const testString = `
ESTE ES UN TÍTULO PRINCIPAL
  
Aquí hay algo de texto.

OTRO TÍTULO

Texto secundario.
  `;

  // Test plain text formatting
  const buffer = Buffer.from(testString, 'utf-8');
  
  try {
    const result = await distiller.processBuffer(buffer, 'text/plain', 'test.txt');
    console.log('--- Original ---');
    console.log(testString);
    console.log('--- Processed ---');
    console.log(result);
    console.log('--- Test Passed ---');
  } catch (err) {
    console.error('Test failed', err);
    process.exit(1);
  }
}

runTest();
