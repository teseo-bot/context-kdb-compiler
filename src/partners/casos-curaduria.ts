/**
 * ADR-224 paso 3 — curaduría de casos de éxito (lado compiler).
 *
 * D-224.2: ningún caso se publica sin curaduría de micontexto. Estas funciones las llama SÓLO el
 * panel de control (control.micontexto.com, `requirePlatformAdmin`) por las rutas
 * `/internal/curaduria-caso*`, autenticadas con una clave PROPIA (`CURADURIA_M2M_API_KEY`), que el
 * portal de aliados no tiene: la clave del portal no puede publicar.
 *
 * Publicar, en este orden:
 *   1. lee el caso y lo revisa entero (el mismo `revisarCasoCompleto` que al mandarlo a revisión);
 *   2. calcula el embedding del `dolor_canonico` FUERA de la transacción (es una llamada de red), con
 *      el mismo cliente de 768 dimensiones que el corpus (`GeminiEmbeddingsClient`);
 *   3. en una transacción, bajo `FOR UPDATE`: comprueba que el caso siga en revisión y sin cambios
 *      desde el paso 1, inserta la versión inmutable en `casos_exito_versiones` y fija en la cabeza
 *      `version_publicada`, `embedding_dolor`, `revisado_por` y `revisado_at`.
 * El CHECK `casos_exito_publicado_completo` y la FK compuesta de la 016 respaldan el paso 3: si
 * algo faltara, la base rechaza la publicación entera.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Pool } from 'pg';
import { EmbeddingsClient } from '../infrastructure/embeddings';
import { CasoFrontmatterSchema, CasoEstado } from './casos-schema';
import {
  CasoConflictoError,
  CasoIncompletoError,
  CasoNoEncontradoError,
  HallazgoCaso,
  revisarCasoCompleto,
} from './casos';

export const MOTIVO_DEVOLUCION_MIN = 10;
export const MOTIVO_DEVOLUCION_MAX = 2_000;

// El uid de Identity Platform del curador. Lo pone el panel de control desde SU sesión.
const CuradorUidSchema = z.string().min(1).max(128);

export const CuraduriaCasoGetInputSchema = z.object({ caso_id: z.string().uuid() });

export const CuraduriaCasoDevolverInputSchema = z.object({
  caso_id: z.string().uuid(),
  curador_uid: CuradorUidSchema,
  motivo: z.string().trim().min(MOTIVO_DEVOLUCION_MIN).max(MOTIVO_DEVOLUCION_MAX),
});
export type CuraduriaCasoDevolverInput = z.infer<typeof CuraduriaCasoDevolverInputSchema>;

export const CuraduriaCasoPublicarInputSchema = z.object({
  caso_id: z.string().uuid(),
  curador_uid: CuradorUidSchema,
});
export type CuraduriaCasoPublicarInput = z.infer<typeof CuraduriaCasoPublicarInputSchema>;

export interface CasoEnCola {
  id: string;
  partner_id: string;
  slug: string;
  titulo: string | null;
  sector: string | null;
  tamano: string | null;
  version_publicada: number | null;
  motivo_devolucion: string | null;
  updated_at: string;
}

export interface VersionCaso {
  version: number;
  content_sha256: string;
  publicado_por: string;
  publicado_at: string;
}

export interface CasoParaCuraduria extends CasoEnCola {
  estado: CasoEstado;
  frontmatter: Record<string, unknown>;
  cuerpo_md: string;
  nota_consultor_md: string;
  revisado_por: string | null;
  revisado_at: string | null;
  created_at: string;
  hallazgos: HallazgoCaso[];
  versiones: VersionCaso[];
}

/** JSON con las llaves de cada objeto ordenadas: el mismo contenido da siempre el mismo texto. */
function jsonCanonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const obj = valor as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jsonCanonico(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor);
}

/**
 * Huella de una versión publicada: sha256 del JSON canónico de `{frontmatter, cuerpo_md,
 * nota_consultor_md}`. Es lo que prueba, al cobrar un fee, qué contenido exacto vio el lead.
 */
export function huellaDeContenido(c: { frontmatter: unknown; cuerpo_md: string; nota_consultor_md: string }): string {
  return createHash('sha256')
    .update(jsonCanonico({ frontmatter: c.frontmatter, cuerpo_md: c.cuerpo_md, nota_consultor_md: c.nota_consultor_md }))
    .digest('hex');
}

/** La cola del curador: todo lo que está en revisión, el más antiguo primero. */
export async function listarEnRevision(pool: Pool): Promise<CasoEnCola[]> {
  const { rows } = await pool.query(
    `SELECT id, partner_id, slug, frontmatter ->> 'titulo' AS titulo, sector, tamano,
            version_publicada, motivo_devolucion, updated_at
       FROM casos_exito
      WHERE estado = 'en_revision'
      ORDER BY updated_at ASC`,
  );
  return rows;
}

export async function obtenerParaCuraduria(pool: Pool, casoId: string): Promise<CasoParaCuraduria> {
  const { rows } = await pool.query(
    `SELECT id, partner_id, slug, estado, frontmatter ->> 'titulo' AS titulo, sector, tamano,
            frontmatter, cuerpo_md, nota_consultor_md, version_publicada, motivo_devolucion,
            revisado_por, revisado_at, created_at, updated_at
       FROM casos_exito WHERE id = $1`,
    [casoId],
  );
  const caso = rows[0];
  if (!caso) throw new CasoNoEncontradoError();
  const { rows: versiones } = await pool.query(
    `SELECT version, content_sha256, publicado_por, publicado_at
       FROM casos_exito_versiones WHERE caso_id = $1 ORDER BY version DESC`,
    [casoId],
  );
  return { ...caso, hallazgos: revisarCasoCompleto(caso), versiones };
}

/** `en_revision → borrador`, con el motivo que verá el aliado. */
export async function devolverCaso(pool: Pool, input: CuraduriaCasoDevolverInput): Promise<CasoParaCuraduria> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT estado FROM casos_exito WHERE id = $1 FOR UPDATE`, [input.caso_id]);
    if (!rows[0]) throw new CasoNoEncontradoError();
    if (rows[0].estado !== 'en_revision') {
      throw new CasoConflictoError(`Sólo se devuelve un caso en revisión; éste está en «${rows[0].estado}».`, rows[0].estado);
    }
    await client.query(
      `UPDATE casos_exito
          SET estado = 'borrador', motivo_devolucion = $2, revisado_por = $3, revisado_at = now(), updated_at = now()
        WHERE id = $1`,
      [input.caso_id, input.motivo.trim(), input.curador_uid],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return obtenerParaCuraduria(pool, input.caso_id);
}

/** `en_revision → publicado`. Ver el orden de los pasos en la cabecera del archivo. */
export async function publicarCaso(
  pool: Pool,
  embeddings: EmbeddingsClient,
  input: CuraduriaCasoPublicarInput,
): Promise<CasoParaCuraduria> {
  const antes = await obtenerParaCuraduria(pool, input.caso_id);
  if (antes.estado !== 'en_revision') {
    throw new CasoConflictoError(`Sólo se publica un caso en revisión; éste está en «${antes.estado}».`, antes.estado);
  }
  if (antes.hallazgos.length > 0) throw new CasoIncompletoError(antes.hallazgos);

  // `leido` detecta un cambio entre la lectura y la transacción; `huella` es la de lo que se
  // guarda en la versión (el encabezado ya validado por el contrato).
  const leido = huellaDeContenido(antes);
  const frontmatter = CasoFrontmatterSchema.parse(antes.frontmatter);
  const huella = huellaDeContenido({ frontmatter, cuerpo_md: antes.cuerpo_md, nota_consultor_md: antes.nota_consultor_md });
  const [embedding] = await embeddings.embed([frontmatter.dolor_canonico]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT estado, frontmatter, cuerpo_md, nota_consultor_md FROM casos_exito WHERE id = $1 FOR UPDATE`,
      [input.caso_id],
    );
    const ahora = rows[0];
    if (!ahora) throw new CasoNoEncontradoError();
    if (ahora.estado !== 'en_revision') {
      throw new CasoConflictoError(`El caso cambió a «${ahora.estado}» mientras se publicaba.`, ahora.estado);
    }
    if (huellaDeContenido(ahora) !== leido) {
      throw new CasoConflictoError('El contenido del caso cambió mientras se publicaba; vuelve a revisarlo.', ahora.estado);
    }

    const { rows: siguiente } = await client.query(
      `SELECT coalesce(max(version), 0) + 1 AS version FROM casos_exito_versiones WHERE caso_id = $1`,
      [input.caso_id],
    );
    const version: number = siguiente[0].version;
    await client.query(
      `INSERT INTO casos_exito_versiones
         (caso_id, version, frontmatter, cuerpo_md, nota_consultor_md, content_sha256, publicado_por)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [input.caso_id, version, JSON.stringify(frontmatter), antes.cuerpo_md, antes.nota_consultor_md, huella, input.curador_uid],
    );
    await client.query(
      `UPDATE casos_exito
          SET estado = 'publicado', version_publicada = $2, embedding_dolor = $3::vector,
              revisado_por = $4, revisado_at = now(), motivo_devolucion = NULL, updated_at = now()
        WHERE id = $1`,
      [input.caso_id, version, `[${embedding.join(',')}]`, input.curador_uid],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return obtenerParaCuraduria(pool, input.caso_id);
}
