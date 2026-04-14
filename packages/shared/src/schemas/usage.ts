import { z } from "zod";

export const LLMCallPurposeSchema = z.enum([
  "analyze-code",
  "analyze-code-light",
  "checkpoint-code-analysis",
  "generate-one-sheet",
  "generate-checkpoint-report",
  "checkpoint-analysis",
  "summarize-harness-logs",
  "classify-ai-usage",
  "other",
]);

export const LLMCallDetailSchema = z.object({
  call_id: z.string(),
  model: z.string(),
  purpose: LLMCallPurposeSchema,
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  cache_write_tokens: z.number().int().nonnegative().default(0),
  latency_ms: z.number().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  started_at: z.string(),
  error: z.string().optional(),
});

export const PipelineUsageEventSchema = z.object({
  pipeline_run_id: z.string(),
  student_id: z.string(),
  cohort_id: z.string(),
  week: z.number().int().nonnegative(),
  kind: z.enum(["grading", "checkpoint", "regression", "dispatch"]),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number().nonnegative(),
  total_input_tokens: z.number().int().nonnegative(),
  total_output_tokens: z.number().int().nonnegative(),
  total_cache_read_tokens: z.number().int().nonnegative().default(0),
  total_cache_write_tokens: z.number().int().nonnegative().default(0),
  total_cost_usd: z.number().nonnegative(),
  calls: z.array(LLMCallDetailSchema).default([]),
});

export type LLMCallPurpose = z.infer<typeof LLMCallPurposeSchema>;
export type LLMCallDetail = z.infer<typeof LLMCallDetailSchema>;
export type PipelineUsageEvent = z.infer<typeof PipelineUsageEventSchema>;
