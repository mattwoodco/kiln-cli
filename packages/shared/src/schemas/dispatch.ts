import { z } from "zod";

/**
 * Phase 7.5 — Artifact dispatch schemas.
 *
 * These mirror the `dispatch_targets` and `dispatch_events` rows defined in
 * `apps/api/drizzle/0005_dispatch.sql`. Re-exported from `@kiln/shared`.
 *
 * IMPORTANT: `auth_secret` is NEVER stored inline. Targets only carry an
 * `authSecretRef` (env var name / secret-store key). The grading worker
 * resolves the actual secret at dispatch time via `resolveSecret()` and
 * never passes it back into any payload, log line, or DB row.
 */

export const ArtifactSelectorSchema = z.enum([
  "one_sheet",
  "logs_summary",
  "sonar_metrics",
  "ai_usage",
  "raw_archive",
]);

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().max(10),
  backoffSeconds: z.array(z.number().int().nonnegative()).min(1).max(10),
});

export const DispatchTriggerSchema = z.enum(["final", "checkpoint"]);

export const DispatchAuthModeSchema = z.enum(["bearer", "hmac", "none"]);

/**
 * The full dispatch_targets row shape. Used by:
 *   - admin CRUD route validation
 *   - grading worker `loadTargets` activity return type
 */
export const DispatchTargetSchema = z.object({
  id: z.string().uuid(),
  cohortId: z.string().uuid(),
  weekId: z.string().uuid().nullable(),
  name: z.string().min(1).max(100),
  url: z.string().url(),
  authMode: DispatchAuthModeSchema,
  /**
   * Reference to a secret in the runtime env (or local secret file).
   * NEVER an inline secret. Optional only when `authMode === "none"`.
   */
  authSecretRef: z.string().min(1).max(200).nullable(),
  artifactSelectors: z.array(ArtifactSelectorSchema).min(1),
  /**
   * Optional transform template. Walked with a safe dotted-path resolver
   * (DEFERRED: full JSONata evaluator). Shape: `{ "outField": "in.path" }`.
   */
  transformTemplate: z.string().nullable(),
  retryPolicy: RetryPolicySchema,
  triggerOn: z.array(DispatchTriggerSchema).min(1),
  enabled: z.boolean(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

/**
 * Admin create payload — accepts the create-time fields. Server fills id,
 * cohortId (from URL), createdAt, updatedAt. Refines: when `authMode !== "none"`
 * `authSecretRef` is required.
 */
export const DispatchTargetCreateSchema = z
  .object({
    weekId: z.string().uuid().nullable().optional(),
    name: z.string().min(1).max(100),
    url: z.string().url(),
    authMode: DispatchAuthModeSchema,
    authSecretRef: z.string().min(1).max(200).nullable().optional(),
    artifactSelectors: z.array(ArtifactSelectorSchema).min(1),
    transformTemplate: z.string().nullable().optional(),
    retryPolicy: RetryPolicySchema.optional(),
    triggerOn: z.array(DispatchTriggerSchema).min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.authMode !== "none" && !data.authSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authSecretRef"],
        message: "authSecretRef is required when authMode != 'none'",
      });
    }
  });

export const DispatchTargetUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  authMode: DispatchAuthModeSchema.optional(),
  authSecretRef: z.string().min(1).max(200).nullable().optional(),
  artifactSelectors: z.array(ArtifactSelectorSchema).min(1).optional(),
  transformTemplate: z.string().nullable().optional(),
  retryPolicy: RetryPolicySchema.optional(),
  triggerOn: z.array(DispatchTriggerSchema).min(1).optional(),
  enabled: z.boolean().optional(),
});

export const DispatchEventStatusSchema = z.enum([
  "pending",
  "success",
  "retrying",
  "failed",
  "dead_letter",
]);

/**
 * Mirror of dispatch_events row. `error` is ALREADY redacted before insert —
 * the worker never lets a raw secret reach this column.
 */
export const DispatchEventSchema = z.object({
  id: z.string().uuid(),
  targetId: z.string().uuid(),
  submissionId: z.string().uuid(),
  cohortId: z.string().uuid(),
  attempt: z.number().int().positive(),
  status: DispatchEventStatusSchema,
  httpStatus: z.number().int().optional().nullable(),
  latencyMs: z.number().int().nonnegative().optional().nullable(),
  error: z.string().optional().nullable(),
  payloadBytes: z.number().int().nonnegative(),
  responseRef: z.string().optional().nullable(),
  createdAt: z.string().optional().nullable(),
});

export type ArtifactSelector = z.infer<typeof ArtifactSelectorSchema>;
export type DispatchAuthMode = z.infer<typeof DispatchAuthModeSchema>;
export type DispatchTarget = z.infer<typeof DispatchTargetSchema>;
export type DispatchTargetCreate = z.infer<typeof DispatchTargetCreateSchema>;
export type DispatchTargetUpdate = z.infer<typeof DispatchTargetUpdateSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type DispatchTrigger = z.infer<typeof DispatchTriggerSchema>;
export type DispatchEvent = z.infer<typeof DispatchEventSchema>;
export type DispatchEventStatus = z.infer<typeof DispatchEventStatusSchema>;
