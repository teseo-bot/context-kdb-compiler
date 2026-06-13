
import { z } from 'zod';

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
});

export const IngestRequestV1Schema = z.object({
  tenant_id: z.string().min(1, "Tenant ID cannot be empty"),
  documents: z.array(IngestDocumentSchema).min(1, "At least one document is required"),
  // Add any other relevant fields for the ingestion request
  workflow_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // For cold-tier migration, we might add a flag or version
  cold_tier_eligible: z.boolean().default(true), 
});

export type IngestDocument = z.infer<typeof IngestDocumentSchema>;
export type IngestRequestV1 = z.infer<typeof IngestRequestV1Schema>;

