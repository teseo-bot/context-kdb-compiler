/**
 * ADR-224 paso 3 — rutas M2M de la autoría de casos (`/internal/partner-caso*`).
 *
 * Las llama el portal de aliados con `x-api-key === M2M_API_KEY`, igual que el resto de
 * `/internal/partner-*`, y con el `partner_id` de SU sesión. La lógica vive en ./casos.ts; aquí
 * sólo se autentica, se valida el body y se traduce cada error a su código HTTP:
 *   ZodError → 422 · CasoIncompletoError → 422 {hallazgos} · CasoNoEncontradoError → 404 ·
 *   CasoConflictoError → 409 {estado}.
 *
 * Ninguna de las rutas del aliado publica (D-224.2). Publicar y devolver son de la curaduría de
 * micontexto: rutas `/internal/curaduria-caso*`, que exigen OTRA clave, `CURADURIA_M2M_API_KEY`,
 * montada sólo en este servicio y en el panel de control. Sin ella puesta, responden 500 y no
 * hacen nada: fallan cerradas.
 */

import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { EmbeddingsClient } from '../infrastructure/embeddings';
import {
  CuraduriaCasoDevolverInputSchema,
  CuraduriaCasoGetInputSchema,
  CuraduriaCasoPublicarInputSchema,
  devolverCaso,
  listarEnRevision,
  obtenerParaCuraduria,
  publicarCaso,
} from './casos-curaduria';
import {
  CasoConflictoError,
  CasoIncompletoError,
  CasoNoEncontradoError,
  PartnerCasoCreateInputSchema,
  PartnerCasoGetInputSchema,
  PartnerCasoSaveInputSchema,
  PartnerCasoSubmitInputSchema,
  PartnerCasosListInputSchema,
  crearCaso,
  enviarARevision,
  guardarBorrador,
  listarCasos,
  obtenerCaso,
} from './casos';

type Manejador = (c: Context) => Promise<Response>;

/**
 * Envuelve un manejador con la autenticación por `x-api-key` contra `process.env[claveEnv]` y la
 * traducción de errores de casos. La clave se lee en cada petición (los tests la fijan en `before`).
 */
export function rutaCasos(ruta: string, claveEnv: string, manejador: Manejador): Manejador {
  return async (c) => {
    const clave = process.env[claveEnv];
    if (!clave) {
      console.error(`${claveEnv} is not set. ${ruta} cannot authenticate requests.`);
      return c.json({ error: `Server configuration error: ${claveEnv} missing.` }, 500);
    }
    if (c.req.header('x-api-key') !== clave) {
      return c.json({ error: 'Unauthorized: Invalid or missing x-api-key.' }, 401);
    }

    try {
      return await manejador(c);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Validation Failed', details: error.issues }, 422);
      }
      if (error instanceof CasoIncompletoError) {
        return c.json({ error: error.message, hallazgos: error.hallazgos }, 422);
      }
      if (error instanceof CasoNoEncontradoError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof CasoConflictoError) {
        return c.json({ error: error.message, estado: error.estado ?? null }, 409);
      }
      console.error(`Error in ${ruta}:`, error);
      return c.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
}

/** Body JSON de la petición; uno ilegible se trata como vacío para que zod lo rechace con 422. */
export async function cuerpoJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

export function registrarRutasCasosAliado(app: Hono, pool: Pool): void {
  const ruta = (path: string, manejador: Manejador) => app.post(path, rutaCasos(path, 'M2M_API_KEY', manejador));

  ruta('/internal/partner-casos-list', async (c) => {
    const input = PartnerCasosListInputSchema.parse(await cuerpoJson(c));
    return c.json({ casos: await listarCasos(pool, input.partner_id) }, 200);
  });

  ruta('/internal/partner-caso-get', async (c) => {
    const input = PartnerCasoGetInputSchema.parse(await cuerpoJson(c));
    return c.json({ caso: await obtenerCaso(pool, input.partner_id, input.caso_id) }, 200);
  });

  ruta('/internal/partner-caso-create', async (c) => {
    const input = PartnerCasoCreateInputSchema.parse(await cuerpoJson(c));
    return c.json({ caso: await crearCaso(pool, input) }, 201);
  });

  ruta('/internal/partner-caso-save', async (c) => {
    const input = PartnerCasoSaveInputSchema.parse(await cuerpoJson(c));
    return c.json({ caso: await guardarBorrador(pool, input) }, 200);
  });

  ruta('/internal/partner-caso-submit', async (c) => {
    const input = PartnerCasoSubmitInputSchema.parse(await cuerpoJson(c));
    return c.json({ caso: await enviarARevision(pool, input.partner_id, input.caso_id) }, 200);
  });
}

export function registrarRutasCuraduria(app: Hono, pool: Pool, embeddings: EmbeddingsClient): void {
  const ruta = (path: string, manejador: Manejador) =>
    app.post(path, rutaCasos(path, 'CURADURIA_M2M_API_KEY', manejador));

  ruta('/internal/curaduria-casos-list', async (c) => {
    return c.json({ casos: await listarEnRevision(pool) }, 200);
  });

  ruta('/internal/curaduria-caso-get', async (c) => {
    const input = CuraduriaCasoGetInputSchema.parse(await cuerpoJson(c));
    return c.json({ caso: await obtenerParaCuraduria(pool, input.caso_id) }, 200);
  });

  ruta('/internal/curaduria-caso-devolver', async (c) => {
    const input = CuraduriaCasoDevolverInputSchema.parse(await cuerpoJson(c));
    return c.json({ caso: await devolverCaso(pool, input) }, 200);
  });

  ruta('/internal/curaduria-caso-publicar', async (c) => {
    const input = CuraduriaCasoPublicarInputSchema.parse(await cuerpoJson(c));
    return c.json({ caso: await publicarCaso(pool, embeddings, input) }, 200);
  });
}
