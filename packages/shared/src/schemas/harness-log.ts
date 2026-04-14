import { z } from "zod";

export const HarnessLogHeadersSchema = z.record(z.string(), z.string());

export const HarnessLogMessageSchema = z.object({
  role: z.string(),
  content: z.unknown(),
});

export const HarnessLogRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  headers: HarnessLogHeadersSchema,
  body: z.unknown().optional(),
  messages: z.array(HarnessLogMessageSchema).optional(),
});

export const HarnessLogUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_read_tokens: z.number().int().nonnegative().optional(),
    cache_write_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const HarnessLogResponseSchema = z.object({
  status: z.number().int(),
  headers: HarnessLogHeadersSchema.optional(),
  body: z.unknown().optional(),
  usage: HarnessLogUsageSchema.optional(),
});

export const HarnessLogEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  source_tool: z.string(),
  model: z.string().optional(),
  request: HarnessLogRequestSchema,
  response: HarnessLogResponseSchema.optional(),
  latency_ms: z.number().nonnegative().optional(),
  upstream: z.enum(["anthropic", "openai", "google"]),
  port: z.number().int().positive(),
  error: z.string().optional(),
});

export type HarnessLogEntry = z.infer<typeof HarnessLogEntrySchema>;
export type HarnessLogRequest = z.infer<typeof HarnessLogRequestSchema>;
export type HarnessLogResponse = z.infer<typeof HarnessLogResponseSchema>;
export type HarnessLogUsage = z.infer<typeof HarnessLogUsageSchema>;
