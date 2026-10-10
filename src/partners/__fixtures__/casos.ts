// Fixtures de casos de éxito (ADR-224) compartidos por casos.test.ts y casos-rutas.test.ts.
// Mismo caso que contracts/src/casos.test.ts: si cambia el contrato, cambian los dos.

import { CASO_SECCIONES } from '../casos-schema';

export function frontmatterValido(): Record<string, unknown> {
  return {
    tipo: 'caso',
    titulo: 'Una transportista de Querétaro deja de perder pedidos por WhatsApp',
    resumen: 'Transportista mediana centraliza pedidos de WhatsApp en un CRM y reduce pedidos perdidos.',
    idioma: 'es',
    sector: 'logistica',
    tamano: 'mediana',
    ubicacion: 'Querétaro',
    anonimizado: true,
    dolor_canonico: 'Los pedidos llegan por WhatsApp a varios teléfonos y se pierden o se duplican.',
    bloques_hocflit: ['C1', 'T1'],
    tecnologias: ['CRM', 'WhatsApp Business API'],
    implementacion: { duracion_semanas: 6, costo_mxn: { min: 40000, max: 80000 }, obstaculo: 'Convencer al equipo de dejar el teléfono personal.' },
    resultado: { kpi: 'Pedidos perdidos al mes', antes: 23, despues: 2, unidad: 'pedidos', periodo_meses: 3 },
    evidencia: { tipo: 'metricas_cliente', fuentes: [`doc:sha256:${'b'.repeat(64)}`], permiso_cliente: 'anonimizado' },
  };
}

export function cuerpoValido(): string {
  return CASO_SECCIONES.map((s, i) =>
    `## ${s}\n\n${i === CASO_SECCIONES.length - 1 ? '¿Cuántos pedidos se le pierden a tu equipo cada mes?' : 'Texto de la sección.'}\n`,
  ).join('\n');
}

export const NOTA_VALIDA =
  'Cubre pedidos perdidos y duplicados. Objeción típica: «ya usamos WhatsApp». Servicio ligado: implantación de CRM.';
