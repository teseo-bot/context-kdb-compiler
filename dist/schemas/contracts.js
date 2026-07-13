"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestRequestV1Schema = exports.IngestDocumentSchema = exports.GenericMessageSchema = exports.ChannelSchema = exports.SenderSchema = exports.HocflitHintSchema = exports.HocflitSystemSchema = exports.HOCFLIT_SYSTEMS = void 0;
const zod_1 = require("zod");
// K9-W1: duplicado consciente de contracts/src/okf.ts::HocflitHintSchema — @teseo/contracts
// no es dependencia npm del compiler (mismo motivo documentado en
// src/infrastructure/concept-frontmatter.schema.ts). Copiado TEXTUALMENTE de
// SPEC-K9-Interfaces-Ingesta.md §1.
// K10-W1: +3 módulos de origen (finanzas, onboarding-academy, direccion) y altitude_min
// opcional (piso de altitud; ver SPEC-K10 — "Dirección" ingesta conocimiento estratégico
// transversal que debe caer en la cola HITL, que exige revisión humana para altitud >= 4).
exports.HOCFLIT_SYSTEMS = [
    'h-talento-humano', 'o-operaciones', 'c-comercial',
    'f-finanzas', 'l-legal', 'i-innovacion', 't-tecnologia',
];
exports.HocflitSystemSchema = zod_1.z.enum(exports.HOCFLIT_SYSTEMS);
exports.HocflitHintSchema = zod_1.z.object({
    system: exports.HocflitSystemSchema, // sesgo primario: tags[0] del concepto resultante
    tags: zod_1.z.array(zod_1.z.string()).optional(), // tags preset del origen (ej. 'pricing', 'icp')
    source_module: zod_1.z.enum([
        'crm-comercial', 'assets-lab', 'compliance-monitor',
        'finanzas', 'onboarding-academy', 'direccion', 'api',
    ]),
    altitude_min: zod_1.z.number().int().min(1).max(5).optional(), // piso de altitud (K10)
});
exports.SenderSchema = zod_1.z.object({
    id: zod_1.z.string().min(1, "Sender ID cannot be empty"),
    name: zod_1.z.string().optional(),
    type: zod_1.z.enum(['human_operator', 'ai_agent', 'system']).default('human_operator'),
});
exports.ChannelSchema = zod_1.z.object({
    id: zod_1.z.string().min(1, "Channel ID cannot be empty"),
    type: zod_1.z.enum(['webchat', 'email', 'sms', 'api', 'internal']).default('webchat'),
    metadata: zod_1.z.record(zod_1.z.any()).optional(),
});
exports.GenericMessageSchema = zod_1.z.object({
    id: zod_1.z.string().min(1, "Message ID cannot be empty"),
    sender: exports.SenderSchema,
    channel: exports.ChannelSchema,
    timestamp: zod_1.z.string().datetime({ message: "Invalid datetime format" }).default(() => new Date().toISOString()),
    content: zod_1.z.string().min(1, "Message content cannot be empty"),
    metadata: zod_1.z.record(zod_1.z.any()).optional(),
});
exports.IngestDocumentSchema = zod_1.z.object({
    document_id: zod_1.z.string().min(1, "Document ID cannot be empty"),
    content: zod_1.z.string().min(1, "Document content cannot be empty"),
    metadata: zod_1.z.record(zod_1.z.any()).optional(),
    // K9-W1b (gap PDFs binarios): cuando content_encoding='base64', `content` es el
    // buffer del archivo original codificado en base64 (no texto). El handler de
    // /v1/ingest lo decodifica y, si mime_type es soportado por DocumentDistiller,
    // extrae el texto/markdown antes de compilar. utf8 (default) preserva el
    // comportamiento previo: `content` ya es texto/markdown plano.
    content_encoding: zod_1.z.enum(['utf8', 'base64']).default('utf8'),
    mime_type: zod_1.z.string().optional(),
});
exports.IngestRequestV1Schema = zod_1.z.object({
    tenant_id: zod_1.z.string().min(1, "Tenant ID cannot be empty"),
    documents: zod_1.z.array(exports.IngestDocumentSchema).min(1, "At least one document is required"),
    // Add any other relevant fields for the ingestion request
    workflow_id: zod_1.z.string().optional(),
    tags: zod_1.z.array(zod_1.z.string()).optional(),
    // For cold-tier migration, we might add a flag or version
    cold_tier_eligible: zod_1.z.boolean().default(true),
    // K9-W1 (SPEC-K9 §2.2): sesgo HOCFLIT de origen, opcional. Se persiste en
    // documents.metadata.hocflit_hint por cada documento del request.
    hocflit_hint: exports.HocflitHintSchema.optional(),
});
