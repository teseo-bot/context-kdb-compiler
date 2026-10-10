// Duplicado consciente de contracts/src/casos.ts (sección «el caso») — unificar cuando contracts
// sea dependencia npm.
//
// Mismo motivo que concept-frontmatter.schema.ts: @teseo/contracts no es dependencia del compiler
// y un import relativo rompe `tsc` con TS6059 (fuera de `rootDir`). Se copia TEXTUALMENTE lo que
// la autoría y la curaduría de casos necesitan validar en el servidor; el portal de aliados
// (aliados-portal/lib/partners/casos.ts) lleva su propia copia en zod v4 para validar en vivo.
// Cualquier cambio del contrato del caso se aplica en los TRES sitios.
//
// ADR-224 D-224.1–D-224.3. Tablas: `casos_exito` + `casos_exito_versiones` (migrations/016 y 017).

import { z } from 'zod';
import { SourceRefSchema } from '../infrastructure/concept-frontmatter.schema';

// Código de bloque HOCFLIT: grupo + nivel de sofisticación. Mismo dominio que
// `hocflit_blocks.code` del plano de control (migrations-gcp/012). E no tiene slug de sistema.
export const HocflitBlockCodeSchema = z.string().regex(
  /^[EIHOCFLT][1-5]$/,
  'bloque HOCFLIT inválido: grupo E|I|H|O|C|F|L|T seguido del nivel 1..5',
);

export const CasoSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/);
export const SectorSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);
export const CasoTamanoSchema = z.enum(['micro', 'pequena', 'mediana', 'grande']);
export type CasoTamano = z.infer<typeof CasoTamanoSchema>;

// D-224.2: el aliado escribe (borrador), lo manda a curaduría (en_revision), micontexto lo
// publica o lo devuelve, y un caso publicado puede retirarse. Sólo `publicado` llega a un lead.
export const CasoEstadoSchema = z.enum(['borrador', 'en_revision', 'publicado', 'retirado']);
export type CasoEstado = z.infer<typeof CasoEstadoSchema>;

export const CASO_TRANSICIONES: Readonly<Record<CasoEstado, readonly CasoEstado[]>> = {
  borrador: ['en_revision'],
  en_revision: ['borrador', 'publicado'],
  publicado: ['retirado', 'en_revision'],
  retirado: ['en_revision'],
};

export function casoPuedeTransitar(de: CasoEstado, a: CasoEstado): boolean {
  return CASO_TRANSICIONES[de].includes(a);
}

export const CasoFrontmatterSchema = z
  .object({
    tipo: z.literal('caso'),
    titulo: z.string().min(1).max(120),
    // Una línea. Es el texto de la opción que recibe JEV (D-224.4): sin nombres propios del lead.
    resumen: z.string().min(1).max(240),
    idioma: z.literal('es'),
    sector: SectorSlugSchema,
    tamano: CasoTamanoSchema,
    ubicacion: z.string().min(2).max(80).optional(),
    anonimizado: z.boolean(),
    // El dolor en palabras canónicas: de aquí sale el embedding contra el dolor del lead.
    dolor_canonico: z.string().min(20).max(400),
    bloques_hocflit: z.array(HocflitBlockCodeSchema).min(1).max(5),
    tecnologias: z.array(z.string().min(2).max(60)).min(1).max(10),
    implementacion: z
      .object({
        duracion_semanas: z.number().int().positive().max(260),
        costo_mxn: z
          .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
          .strict()
          .refine((c) => c.max >= c.min, 'costo_mxn.max debe ser mayor o igual que costo_mxn.min'),
        obstaculo: z.string().min(10).max(280),
      })
      .strict(),
    resultado: z
      .object({
        kpi: z.string().min(3).max(120),
        antes: z.number(),
        despues: z.number(),
        unidad: z.string().min(1).max(40),
        periodo_meses: z.number().int().positive().max(60).optional(),
      })
      .strict()
      .refine((r) => r.antes !== r.despues, 'un resultado sin cambio entre antes y después no es un caso de éxito'),
    // D-224.2: ningún caso se publica sin evidencia del resultado y permiso del cliente.
    evidencia: z
      .object({
        tipo: z.enum(['documento', 'metricas_cliente', 'testimonio_firmado', 'publicacion']),
        fuentes: z.array(SourceRefSchema).min(1),
        permiso_cliente: z.enum(['explicito', 'anonimizado']),
      })
      .strict(),
  })
  .strict()
  .refine(
    (fm) => fm.anonimizado || fm.evidencia.permiso_cliente === 'explicito',
    'un caso que nombra al cliente exige permiso_cliente = explicito',
  );
export type CasoFrontmatter = z.infer<typeof CasoFrontmatterSchema>;

// D-224.1: el método del caso de Harvard, simplificado. Seis secciones fijas, en este orden, como
// encabezados `## …` del cuerpo. La última devuelve la decisión al lector: su respuesta reabre la
// conversación y reinicia la ventana de 24 h.
export const CASO_SECCIONES = [
  'Protagonista',
  'Dolor',
  'Decisión',
  'Implementación',
  'Resultado',
  'Pregunta de cierre',
] as const;

export interface CasoHallazgo {
  regla: 'seccion-faltante' | 'seccion-vacia' | 'seccion-fuera-de-orden' | 'cierre-sin-pregunta';
  mensaje_es: string;
}

/**
 * Revisa la forma del cuerpo de un caso. Devuelve una lista vacía si el cuerpo es válido.
 * Pura: no toca red ni disco. La usan el portal de aliados al validar el borrador y la
 * curaduría antes de publicar.
 */
export function revisarCuerpoCaso(markdown: string): CasoHallazgo[] {
  const hallazgos: CasoHallazgo[] = [];
  const encabezados: { titulo: string; indice: number }[] = [];
  const re = /^##[ \t]+(.+?)[ \t]*$/gm;
  for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) {
    encabezados.push({ titulo: (m[1] ?? '').trim(), indice: m.index });
  }
  // El texto de una sección va de su encabezado al siguiente `## …`, sin el encabezado.
  const textoDe = (i: number): string =>
    markdown.slice(encabezados[i]?.indice ?? 0, encabezados[i + 1]?.indice ?? markdown.length).replace(/^##.*$/m, '');

  const posiciones = CASO_SECCIONES.map((s) => encabezados.findIndex((e) => e.titulo === s));
  CASO_SECCIONES.forEach((seccion, i) => {
    const p = posiciones[i] ?? -1;
    if (p === -1) {
      hallazgos.push({ regla: 'seccion-faltante', mensaje_es: `Falta la sección «## ${seccion}».` });
    } else if (textoDe(p).trim() === '') {
      // Seis encabezados sin texto pasaban la revisión: la parte se nombra, pero no se cuenta.
      hallazgos.push({ regla: 'seccion-vacia', mensaje_es: `La sección «## ${seccion}» está vacía.` });
    }
  });

  const presentes = posiciones.filter((p) => p !== -1);
  for (let i = 1; i < presentes.length; i++) {
    if ((presentes[i] ?? 0) < (presentes[i - 1] ?? 0)) {
      hallazgos.push({
        regla: 'seccion-fuera-de-orden',
        mensaje_es: `Las secciones deben ir en este orden: ${CASO_SECCIONES.join(' → ')}.`,
      });
      break;
    }
  }

  // Un cierre vacío ya salió como `seccion-vacia`: no se reporta dos veces.
  const cierre = posiciones[CASO_SECCIONES.length - 1] ?? -1;
  if (cierre !== -1) {
    const texto = textoDe(cierre);
    if (texto.trim() !== '' && !texto.includes('?')) {
      hallazgos.push({
        regla: 'cierre-sin-pregunta',
        mensaje_es: 'La «Pregunta de cierre» tiene que preguntarle algo al lector.',
      });
    }
  }
  return hallazgos;
}
