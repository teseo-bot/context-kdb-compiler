"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestRequestV1Schema = exports.IngestDocumentSchema = exports.GenericMessageSchema = exports.ChannelSchema = exports.SenderSchema = void 0;
const zod_1 = require("zod");
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
});
exports.IngestRequestV1Schema = zod_1.z.object({
    tenant_id: zod_1.z.string().min(1, "Tenant ID cannot be empty"),
    documents: zod_1.z.array(exports.IngestDocumentSchema).min(1, "At least one document is required"),
    // Add any other relevant fields for the ingestion request
    workflow_id: zod_1.z.string().optional(),
    tags: zod_1.z.array(zod_1.z.string()).optional(),
    // For cold-tier migration, we might add a flag or version
    cold_tier_eligible: zod_1.z.boolean().default(true),
});
