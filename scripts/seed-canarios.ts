/**
 * seed-canarios.ts — siembra canarios de aislamiento (ADR-210 D-210.8 · SB5-W1)
 *
 * PARA QUÉ. Un sistema multitenant con un solo tenant no tiene caso de prueba: "está
 * aislado" es una creencia. Esto la convierte en un test. Siembra en un tenant filas
 * marcadas con un token único e improbable; después, cualquier aparición de ese token
 * en las respuestas del agente de OTRO tenant, o en un sink de log, es una fuga
 * demostrada — no una sospecha.
 *
 * DOS RUTAS DE FUGA, y por qué el embedding importa:
 *   1. Ruta de VOLCADO (logs, exports, dumps): basta con que la fila exista. El token
 *      se encuentra con `grep`.
 *   2. Ruta de CONSULTA (el RAG de otro tenant recupera esta fila): la fila tiene que
 *      ser RECUPERABLE. Un chunk con `embedding` NULL, o embebido con OTRO modelo, es
 *      INERTE para esta ruta — cae en un espacio vectorial distinto y ninguna consulta
 *      real lo alcanza nunca. Es exactamente el bug que inutilizó el write-path legacy
 *      `insertChunk` (text-embedding-004 contra gemini-embedding-001@768): escribía de
 *      verdad y aun así el RAG nunca lo veía.
 *   Por eso este script usa el MISMO cliente de embeddings que el write-path real
 *   (`GeminiEmbeddingsClient`), y si se le pide `--mock` AVISA A GRITOS de que los
 *   canarios quedan ciegos para la ruta 2.
 *
 * USO
 *   npx tsx scripts/seed-canarios.ts --tenant-id <uuid> --db-url <postgres://...> [--n 5] [--schema kdb] [--mock]
 *
 *   Los tokens salen por STDOUT, uno por línea y nada más, para poder hacer:
 *     npx tsx scripts/seed-canarios.ts ... > /tmp/tokens.txt
 *   Todo lo demás (avisos, resumen) va por STDERR.
 *
 * ⛔ NO apuntar a la base de un tenant con datos reales de cliente. Está pensado para
 *    el tenant de referencia (micontexto-tenant2) o para una base desechable.
 */

import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { EmbeddingsClient, GeminiEmbeddingsClient } from '../src/infrastructure/embeddings';
import { MockEmbeddingsClient } from '../src/infrastructure/embeddings.mock';

interface Args {
  tenantId: string;
  dbUrl: string;
  n: number;
  schema: string;
  mock: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const tenantId = get('--tenant-id');
  const dbUrl = get('--db-url');

  // Fail-fast SIN defaults: un default de tenant o de base es cómo se siembran canarios
  // en el sitio equivocado. Si falta, se aborta.
  const missing: string[] = [];
  if (!tenantId) missing.push('--tenant-id');
  if (!dbUrl) missing.push('--db-url');
  if (missing.length > 0) {
    console.error(`[seed-canarios] FALTAN argumentos obligatorios: ${missing.join(', ')}`);
    console.error('  Uso: --tenant-id <uuid> --db-url <postgres://...> [--n 5] [--schema kdb] [--mock]');
    console.error('  No hay valores por defecto para esos dos, a propósito.');
    process.exit(1);
  }

  const nRaw = get('--n');
  const n = nRaw === undefined ? 5 : Number.parseInt(nRaw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    console.error(`[seed-canarios] --n inválido (${nRaw}): entero entre 1 y 100.`);
    process.exit(1);
  }

  return {
    tenantId: tenantId as string,
    dbUrl: dbUrl as string,
    n,
    schema: get('--schema') ?? 'kdb',
    mock: argv.includes('--mock'),
  };
}

/** Slug corto y estable del tenant, para que el token diga a quién pertenece. */
function slug(tenantId: string): string {
  const clean = tenantId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  // Los UUID de tenant son 0000…0001 / 0000…0002: los ceros iniciales no distinguen.
  const tail = clean.replace(/^0+/, '') || clean;
  return tail.slice(0, 8) || 'ANON';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.schema)) {
    console.error(`[seed-canarios] --schema inválido: ${args.schema}`);
    process.exit(1);
  }

  const embeddings: EmbeddingsClient = args.mock
    ? new MockEmbeddingsClient()
    : new GeminiEmbeddingsClient();

  if (args.mock) {
    console.error('');
    console.error('  ⚠️  ═══════════════════════════════════════════════════════════════');
    console.error('  ⚠️   MODO --mock: los embeddings NO son reales.');
    console.error('  ⚠️   Estos canarios sirven para la ruta de VOLCADO (logs, exports,');
    console.error('  ⚠️   dumps) pero son CIEGOS para la ruta de CONSULTA: caen en otro');
    console.error('  ⚠️   espacio vectorial, así que ninguna búsqueda real los alcanza.');
    console.error('  ⚠️   NO afirmes "el RAG está aislado" con canarios de --mock.');
    console.error('  ⚠️  ═══════════════════════════════════════════════════════════════');
    console.error('');
  }

  const pool = new Pool({ connectionString: args.dbUrl, max: 2 });
  const tokens: string[] = [];
  const S = args.schema;
  const prefix = slug(args.tenantId);

  const client = await pool.connect();
  try {
    for (let i = 0; i < args.n; i++) {
      const token = `CANARY-${prefix}-${randomUUID()}`;

      // El token va DENTRO del texto, no solo en metadata: así lo encuentra un `grep`
      // sobre un volcado y además una consulta por ese texto puede recuperarlo.
      const body =
        `${token}\n` +
        `Documento canario de aislamiento (ADR-210 D-210.8). Tenant ${args.tenantId}.\n` +
        `Si este texto aparece en la respuesta del agente de otro tenant, o en un log ` +
        `compartido, hay una fuga de aislamiento demostrada.`;

      const [embedding] = await embeddings.embed([body]);
      if (!embedding) throw new Error('el cliente de embeddings no devolvió vector');
      const vector = `[${embedding.join(',')}]`;

      await client.query('BEGIN');
      try {
        const doc = await client.query<{ id: string }>(
          `INSERT INTO ${S}.documents (tenant_id, document_hash, filename, content, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
          [args.tenantId, token, `${token}.md`, body, JSON.stringify({ canary: true, token })]
        );
        const documentId = doc.rows[0]?.id;
        if (!documentId) throw new Error('el INSERT de documents no devolvió id');

        await client.query(
          `INSERT INTO ${S}.chunks (tenant_id, document_id, chunk_index, chunk_text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb)`,
          [args.tenantId, documentId, 0, body, vector, JSON.stringify({ canary: true, token })]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }

      tokens.push(token);
      // STDOUT = solo tokens, para poder redirigirlo limpio.
      process.stdout.write(`${token}\n`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.error(
    `[seed-canarios] ${tokens.length} canario(s) en ${S}.documents + ${S}.chunks ` +
    `del tenant ${args.tenantId}${args.mock ? ' (EMBEDDINGS MOCK — ver aviso arriba)' : ''}.`
  );
  console.error('[seed-canarios] Siguiente paso: qa/canarios/assert-sin-fuga.sh (ver su README).');
}

main().catch((err) => {
  console.error('[seed-canarios] FALLÓ:', err instanceof Error ? err.message : err);
  process.exit(1);
});
