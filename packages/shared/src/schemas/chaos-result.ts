import { z } from "zod";

export const ChaosFaultKindSchema = z.enum([
  "latency",
  "drop",
  "error_status",
  "partial_response",
  "rate_limit",
  "token_limit",
  "mutation",
  "disconnect",
]);

export const ChaosFaultSchema = z.object({
  kind: ChaosFaultKindSchema,
  target: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({}),
});

export const SteadyStateSchema = z.object({
  checked_at: z.string(),
  passed: z.boolean(),
  metrics: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().optional(),
});

export const ChaosVerdictSchema = z.enum(["PASS", "FAIL", "DEGRADED"]);

export const ChaosProfileKindSchema = z.enum(["visible", "hidden"]);

export const ChaosResultSchema = z.object({
  experiment_id: z.string(),
  fault: ChaosFaultSchema,
  steady_state_pre: SteadyStateSchema,
  steady_state_post: SteadyStateSchema,
  verdict: ChaosVerdictSchema,
  started_at: z.string(),
  duration_ms: z.number().nonnegative(),
  profile_kind: ChaosProfileKindSchema.optional(),
  observations: z.array(z.string()).default([]),
});

export type ChaosFault = z.infer<typeof ChaosFaultSchema>;
export type ChaosFaultKind = z.infer<typeof ChaosFaultKindSchema>;
export type ChaosResult = z.infer<typeof ChaosResultSchema>;
export type ChaosVerdict = z.infer<typeof ChaosVerdictSchema>;
export type ChaosProfileKind = z.infer<typeof ChaosProfileKindSchema>;
export type SteadyState = z.infer<typeof SteadyStateSchema>;
