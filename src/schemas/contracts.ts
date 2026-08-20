
import { z } from 'zod';

// K9-W1: duplicado consciente de contracts/src/okf.ts::HocflitHintSchema — @teseo/contracts
// no es dependencia npm del compiler (mismo motivo documentado en
// src/infrastructure/concept-frontmatter.schema.ts). Copiado TEXTUALMENTE de
// SPEC-K9-Interfaces-Ingesta.md §1.
// K10-W1: +3 módulos de origen (finanzas, onboarding-academy, direccion) y altitude_min
// opcional (piso de altitud; ver SPEC-K10 — "Dirección" ingesta conocimiento estratégico
// transversal que debe caer en la cola HITL, que exige revisión humana para altitud >= 4).
export const HOCFLIT_SYSTEMS = [
  'h-talento-humano', 'o-operaciones', 'c-comercial',
  'f-finanzas', 'l-legal', 'i-innovacion', 't-tecnologia',
] as const;
export const HocflitSystemSchema = z.enum(HOCFLIT_SYSTEMS);

export const HocflitHintSchema = z.object({
  system: HocflitSystemSchema,              // sesgo primario: tags[0] del concepto resultante
  tags: z.array(z.string()).optional(),     // tags preset del origen (ej. 'pricing', 'icp')
  source_module: z.enum([
    'crm-comercial', 'assets-lab', 'compliance-monitor',
    'finanzas', 'onboarding-academy', 'direccion', 'api',
  ]),
  altitude_min: z.number().int().min(1).max(5).optional(),  // piso de altitud (K10)
});
export type HocflitHint = z.infer<typeof HocflitHintSchema>;

export const SenderSchema = z.object({
  id: z.string().min(1, "Sender ID cannot be empty"),
  name: z.string().optional(),
  type: z.enum(['human_operator', 'ai_agent', 'system']).default('human_operator'),
});

export const ChannelSchema = z.object({
  id: z.string().min(1, "Channel ID cannot be empty"),
  type: z.enum(['webchat', 'email', 'sms', 'api', 'internal']).default('webchat'),
  metadata: z.record(z.any()).optional(),
});

export const GenericMessageSchema = z.object({
  id: z.string().min(1, "Message ID cannot be empty"),
  sender: SenderSchema,
  channel: ChannelSchema,
  timestamp: z.string().datetime({ message: "Invalid datetime format" }).default(() => new Date().toISOString()),
  content: z.string().min(1, "Message content cannot be empty"),
  metadata: z.record(z.any()).optional(),
});

export type Sender = z.infer<typeof SenderSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type GenericMessage = z.infer<typeof GenericMessageSchema>;

export const IngestDocumentSchema = z.object({
  document_id: z.string().min(1, "Document ID cannot be empty"),
  content: z.string().min(1, "Document content cannot be empty"),
  metadata: z.record(z.any()).optional(),
  // K9-W1b (gap PDFs binarios): cuando content_encoding='base64', `content` es el
  // buffer del archivo original codificado en base64 (no texto). El handler de
  // /v1/ingest lo decodifica y, si mime_type es soportado por DocumentDistiller,
  // extrae el texto/markdown antes de compilar. utf8 (default) preserva el
  // comportamiento previo: `content` ya es texto/markdown plano.
  content_encoding: z.enum(['utf8', 'base64']).default('utf8'),
  mime_type: z.string().optional(),
});

export const IngestRequestV1Schema = z.object({
  tenant_id: z.string().min(1, "Tenant ID cannot be empty"),
  documents: z.array(IngestDocumentSchema).min(1, "At least one document is required"),
  // Add any other relevant fields for the ingestion request
  workflow_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // For cold-tier migration, we might add a flag or version
  cold_tier_eligible: z.boolean().default(true),
  // K9-W1 (SPEC-K9 §2.2): sesgo HOCFLIT de origen, opcional. Se persiste en
  // documents.metadata.hocflit_hint por cada documento del request.
  hocflit_hint: HocflitHintSchema.optional(),
  // ADR-215 WU-4.4: marcas a las que pertenece el material de este request.
  //
  // ⚠️ Va como HERMANO de `hocflit_hint`, NUNCA dentro ([INV-215.4]). El hint es el eje de la
  // taxonomía HOCFLIT (sistema + altitud); la marca es un eje NUEVO y ortogonal. Meterla
  // dentro del hint las conflaría, y conflar ejes ya costó una corrección en este programa.
  //
  // AUSENTE o VACÍO = COMPARTIDO, visible para todas las marcas ([INV-215.5]). No es un
  // descuido del cliente: es el default correcto, y el que preserva el retargeting. Por eso
  // el campo es opcional y no tiene default no-vacío.
  brand_slugs: z.array(z.string()).optional(),

  // ADR-220 D-220.1 — el eje de PROYECTO. Hermano de `brand_slugs` y NUNCA el mismo campo:
  // reutilizar aquél haría que el significado dependiera del tenant, y el predicado correcto
  // con él. Un tenant puede tener los dos ejes a la vez.
  //
  // AUSENTE o VACÍO = BASE DEL TENANT, visible para todos sus agentes. Mismo predicado que la
  // marca, y tiene que serlo: lo contrario dejaría inaccesible todo lo cargado antes de que
  // existieran los proyectos. La inversión que pide D-220.2 —proyecto preseleccionado, base
  // del tenant a mano— vive en el PANEL, no en el contrato.
  project_slugs: z.array(z.string()).optional(),
});

export type IngestDocument = z.infer<typeof IngestDocumentSchema>;
export type IngestRequestV1 = z.infer<typeof IngestRequestV1Schema>;

