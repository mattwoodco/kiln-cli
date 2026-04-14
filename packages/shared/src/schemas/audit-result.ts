import { z } from "zod";

export const AuditCheckStatusSchema = z.enum(["pass", "warn", "fail", "skip"]);

export const AuditCheckSchema = z.object({
  name: z.string(),
  status: AuditCheckStatusSchema,
  message: z.string(),
  fix: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const AuditResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(AuditCheckSchema),
  warnings: z.array(z.string()).default([]),
  generated_at: z.string(),
});

export type AuditCheck = z.infer<typeof AuditCheckSchema>;
export type AuditCheckStatus = z.infer<typeof AuditCheckStatusSchema>;
export type AuditResult = z.infer<typeof AuditResultSchema>;
