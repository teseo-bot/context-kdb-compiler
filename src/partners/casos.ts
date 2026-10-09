/**
 * ADR-224 paso 3 — autoría de casos de éxito (lado compiler).
 *
 * El portal de aliados escribe los casos A TRAVÉS de estas funciones (rutas
 * `/internal/partner-caso*` en src/server.ts): el portal no tiene credencial del Cold-Tier.
 *
 * ⛔ AISLAMIENTO POR ALIADO = el `WHERE partner_id = $1` de CADA consulta. El compiler conecta como
 * `kdb_compiler`, que tiene BYPASSRLS: las políticas de la 016 (`app.partner_id`) no le aplican.
 * El `partner_id` llega siempre de la SESIÓN del portal, nunca del cliente.
 *
 * El aliado sólo edita borradores y sólo los manda a revisión (`borrador → en_revision`). Nunca
 * publica (D-224.2): eso es la curaduría de micontexto, en otro módulo y con otra clave.
 *
 * Al guardar un borrador sólo se exige la forma mínima (objeto JSON, tamaños), para poder guardar a
 * medias. El contrato completo —encabezado, seis secciones con texto y nota del consultor— se exige
 * al mandarlo a revisión. La base respalda la nota con su CHECK `casos_exito_revision_con_nota`.
 */

import { z } from 'zod';
import { Pool } from 'pg';
import { CasoFrontmatterSchema, CasoSlugSchema, CasoEstado, revisarCuerpoCaso } from './casos-schema';

// La 016 exige `length(btrim(nota)) >= 40` para entrar en revisión. `btrim` de Postgres sólo quita
// espacios; `trim()` de JS quita además saltos y tabuladores, así que medir con `trim()` es más
// estricto que la base y nunca deja pasar algo que el CHECK rechace.
export const NOTA_CONSULTOR_MIN = 40;
export const CUERPO_MAX = 20_000;
export const NOTA_MAX = 10_000;
export const FRONTMATTER_MAX_BYTES = 16_000;

const FrontmatterBorradorSchema = z
  .record(z.unknown())
  .refine((fm) => Buffer.byteLength(JSON.stringify(fm), 'utf8') <= FRONTMATTER_MAX_BYTES, {
    message: `el encabezado no puede pasar de ${FRONTMATTER_MAX_BYTES} bytes`,
  });

const ContenidoBorradorSchema = {
  frontmatter: FrontmatterBorradorSchema,
  cuerpo_md: z.string().max(CUERPO_MAX),
  nota_consultor_md: z.string().max(NOTA_MAX),
};

export const PartnerCasosListInputSchema = z.object({ partner_id: z.string().uuid() });

export const PartnerCasoGetInputSchema = z.object({
  partner_id: z.string().uuid(),
  caso_id: z.string().uuid(),
});

export const PartnerCasoCreateInputSchema = z.object({
  partner_id: z.string().uuid(),
  slug: CasoSlugSchema,
  ...ContenidoBorradorSchema,
});
export type PartnerCasoCreateInput = z.infer<typeof PartnerCasoCreateInputSchema>;

export const PartnerCasoSaveInputSchema = z.object({
  partner_id: z.string().uuid(),
  caso_id: z.string().uuid(),
  ...ContenidoBorradorSchema,
});
export type PartnerCasoSaveInput = z.infer<typeof PartnerCasoSaveInputSchema>;

export const PartnerCasoSubmitInputSchema = PartnerCasoGetInputSchema;

export class CasoNoEncontradoError extends Error {
  constructor() {
    super('Caso no encontrado');
    this.name = 'CasoNoEncontradoError';
  }
}

/** 409: el caso existe pero su estado no admite la operación, o el slug ya está tomado. */
export class CasoConflictoError extends Error {
  estado?: CasoEstado;
  constructor(message: string, estado?: CasoEstado) {
    super(message);
    this.name = 'CasoConflictoError';
    this.estado = estado;
  }
}

/** 422: el caso no cumple el contrato para entrar en revisión. */
export class CasoIncompletoError extends Error {
  hallazgos: HallazgoCaso[];
  constructor(hallazgos: HallazgoCaso[]) {
    super('El caso no está completo para revisión');
    this.name = 'CasoIncompletoError';
    this.hallazgos = hallazgos;
  }
}

export interface HallazgoCaso {
  /** `frontmatter.<ruta>`, `cuerpo_md` o `nota_consultor_md`. */
  campo: string;
  regla: string;
  mensaje_es: string;
}

/**
 * Lo que tiene que cumplir un caso para entrar en revisión (y, en la curaduría, para publicarse).
 * Pura. Lista vacía = cumple.
 */
export function revisarCasoCompleto(caso: {
  frontmatter: unknown;
  cuerpo_md: string;
  nota_consultor_md: string;
}): HallazgoCaso[] {
  const hallazgos: HallazgoCaso[] = [];

  const fm = CasoFrontmatterSchema.safeParse(caso.frontmatter);
  if (!fm.success) {
    for (const issue of fm.error.issues) {
      hallazgos.push({
        campo: ['frontmatter', ...issue.path].join('.'),
        regla: `encabezado-${issue.code}`,
        mensaje_es: issue.message,
      });
    }
  }

  for (const h of revisarCuerpoCaso(caso.cuerpo_md)) {
    hallazgos.push({ campo: 'cuerpo_md', regla: h.regla, mensaje_es: h.mensaje_es });
  }

  if (caso.nota_consultor_md.trim().length < NOTA_CONSULTOR_MIN) {
    hallazgos.push({
      campo: 'nota_consultor_md',
      regla: 'nota-corta',
      mensaje_es: `La nota del consultor necesita al menos ${NOTA_CONSULTOR_MIN} caracteres.`,
    });
  }
  return hallazgos;
}

export interface CasoResumen {
  id: string;
  slug: string;
  estado: CasoEstado;
  titulo: string | null;
  sector: string | null;
  tamano: string | null;
  version_publicada: number | null;
  motivo_devolucion: string | null;
  revisado_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CasoDetalle extends CasoResumen {
  frontmatter: Record<string, unknown>;
  cuerpo_md: string;
  nota_consultor_md: string;
}

// `revisado_por` (uid del curador de micontexto), el embedding y el tsvector no salen hacia el
// aliado: no los necesita y el uid es un dato interno.
const COLUMNAS_RESUMEN = `id, slug, estado, frontmatter ->> 'titulo' AS titulo, sector, tamano,
  version_publicada, motivo_devolucion, revisado_at, created_at, updated_at`;
const COLUMNAS_DETALLE = `${COLUMNAS_RESUMEN}, frontmatter, cuerpo_md, nota_consultor_md`;

export async function listarCasos(pool: Pool, partnerId: string): Promise<CasoResumen[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS_RESUMEN} FROM casos_exito WHERE partner_id = $1 ORDER BY updated_at DESC`,
    [partnerId],
  );
  return rows;
}

export async function obtenerCaso(pool: Pool, partnerId: string, casoId: string): Promise<CasoDetalle> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS_DETALLE} FROM casos_exito WHERE id = $1 AND partner_id = $2`,
    [casoId, partnerId],
  );
  if (!rows[0]) throw new CasoNoEncontradoError();
  return rows[0];
}

export async function crearCaso(pool: Pool, input: PartnerCasoCreateInput): Promise<CasoDetalle> {
  try {
    const { rows } = await pool.query(
      `INSERT INTO casos_exito (partner_id, slug, frontmatter, cuerpo_md, nota_consultor_md)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING ${COLUMNAS_DETALLE}`,
      [input.partner_id, input.slug, JSON.stringify(input.frontmatter), input.cuerpo_md, input.nota_consultor_md],
    );
    return rows[0];
  } catch (error: any) {
    if (error?.code === '23505') {
      throw new CasoConflictoError(`Ya tienes un caso con el identificador «${input.slug}».`);
    }
    throw error;
  }
}

/** Distingue «no es tuyo / no existe» (404) de «existe pero no está en borrador» (409). */
async function conflictoOAusencia(pool: Pool, partnerId: string, casoId: string, accion: string): Promise<never> {
  const { rows } = await pool.query(`SELECT estado FROM casos_exito WHERE id = $1 AND partner_id = $2`, [
    casoId,
    partnerId,
  ]);
  if (!rows[0]) throw new CasoNoEncontradoError();
  throw new CasoConflictoError(`Sólo se puede ${accion} un caso en borrador; éste está en «${rows[0].estado}».`, rows[0].estado);
}

export async function guardarBorrador(pool: Pool, input: PartnerCasoSaveInput): Promise<CasoDetalle> {
  const { rows } = await pool.query(
    `UPDATE casos_exito
        SET frontmatter = $3::jsonb, cuerpo_md = $4, nota_consultor_md = $5, updated_at = now()
      WHERE id = $1 AND partner_id = $2 AND estado = 'borrador'
      RETURNING ${COLUMNAS_DETALLE}`,
    [input.caso_id, input.partner_id, JSON.stringify(input.frontmatter), input.cuerpo_md, input.nota_consultor_md],
  );
  if (!rows[0]) return conflictoOAusencia(pool, input.partner_id, input.caso_id, 'editar');
  return rows[0];
}

/**
 * `borrador → en_revision`. Revisa el caso guardado (no lo que mande el cliente) bajo `FOR UPDATE`,
 * para que un guardado concurrente no cuele contenido sin revisar entre la revisión y el cambio.
 * El motivo de una devolución anterior se conserva: el curador lo ve junto a la versión corregida.
 */
export async function enviarARevision(pool: Pool, partnerId: string, casoId: string): Promise<CasoDetalle> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT estado, frontmatter, cuerpo_md, nota_consultor_md
         FROM casos_exito WHERE id = $1 AND partner_id = $2 FOR UPDATE`,
      [casoId, partnerId],
    );
    const caso = rows[0];
    if (!caso) throw new CasoNoEncontradoError();
    if (caso.estado !== 'borrador') {
      throw new CasoConflictoError(`Sólo se manda a revisión un caso en borrador; éste está en «${caso.estado}».`, caso.estado);
    }
    const hallazgos = revisarCasoCompleto(caso);
    if (hallazgos.length > 0) throw new CasoIncompletoError(hallazgos);

    const { rows: actualizados } = await client.query(
      `UPDATE casos_exito SET estado = 'en_revision', updated_at = now()
        WHERE id = $1 AND partner_id = $2
        RETURNING ${COLUMNAS_DETALLE}`,
      [casoId, partnerId],
    );
    await client.query('COMMIT');
    return actualizados[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
