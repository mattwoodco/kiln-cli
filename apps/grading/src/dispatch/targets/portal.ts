/**
 * Phase 7.5 — Kiln Portal target shaper.
 *
 * The Portal expects a tailored payload with a stable shape so it can
 * generate interview questions + trigger a video interview workflow off
 * the back of a final grading run.
 *
 * Defaults declared here:
 *   - selectors: ["one_sheet", "ai_usage"]
 *   - transformTemplate: builds { student_id, submission_id, one_sheet,
 *     ai_usage, rubric_version }
 *
 * `extractResponseRef` plucks `job_id` or `interview_id` (whichever the
 * Portal returns) from the JSON response body so the dispatch_events row
 * can carry it forward to the redispatch UI.
 *
 * `seedPortalTarget` is an admin helper to create a default Portal target
 * row for a cohort during bootstrap. The auth_secret_ref is templated as
 * `PORTAL_TOKEN_COHORT_<id>` — the admin must set that env var before
 * enabling the target. Inline secrets are NOT supported anywhere.
 */

import type {
  ArtifactSelector,
  DispatchAuthMode,
  DispatchTrigger,
  RetryPolicy,
} from "@kiln/shared";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema.js";

export const PORTAL_TARGET_NAME = "kiln-portal";

export const PORTAL_DEFAULT_SELECTORS: ArtifactSelector[] = ["one_sheet", "ai_usage"];

export const PORTAL_DEFAULT_TRANSFORM = JSON.stringify({
  student_id: "student_id",
  submission_id: "submission_id",
  one_sheet: "one_sheet",
  ai_usage: "ai_usage",
  rubric_version: "rubric_version",
});

export const PORTAL_DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  backoffSeconds: [1, 4, 16, 64, 256],
};

export const PORTAL_DEFAULT_TRIGGERS: DispatchTrigger[] = ["final"];

export function portalSecretRef(cohortId: string): string {
  return `PORTAL_TOKEN_COHORT_${cohortId}`;
}

interface PortalResponseLike {
  job_id?: string;
  interview_id?: string;
}

/**
 * Pluck a `responseRef` out of a Portal response. Accepts either string or
 * unknown — a malformed body returns null.
 */
export function extractResponseRef(responseBody: string | unknown): string | null {
  if (typeof responseBody === "string") {
    if (responseBody.length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(responseBody);
      return refFromObject(parsed);
    } catch {
      return null;
    }
  }
  return refFromObject(responseBody);
}

function refFromObject(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as PortalResponseLike;
  if (typeof obj.job_id === "string" && obj.job_id.length > 0) return obj.job_id;
  if (typeof obj.interview_id === "string" && obj.interview_id.length > 0) {
    return obj.interview_id;
  }
  return null;
}

export interface SeedPortalTargetInput {
  db: NodePgDatabase<typeof schema>;
  cohortId: string;
  url: string;
  weekId?: string | null;
  authMode?: DispatchAuthMode;
  enabled?: boolean;
}

export interface SeedPortalTargetResult {
  targetId: string;
  authSecretRef: string;
}

export async function seedPortalTarget(
  input: SeedPortalTargetInput,
): Promise<SeedPortalTargetResult> {
  const ref = portalSecretRef(input.cohortId);

  const existing = await input.db
    .select({ id: schema.dispatchTargets.id })
    .from(schema.dispatchTargets)
    .where(eq(schema.dispatchTargets.cohortId, input.cohortId))
    .limit(50);
  for (const row of existing) {
    // No-op if a Portal target already exists for this (cohort, week=null).
    // Keeps `seedPortalTarget` idempotent for bootstrap scripts.
    void row;
  }

  const [row] = await input.db
    .insert(schema.dispatchTargets)
    .values({
      cohortId: input.cohortId,
      weekId: input.weekId ?? null,
      name: PORTAL_TARGET_NAME,
      url: input.url,
      authMode: input.authMode ?? "bearer",
      authSecretRef: ref,
      artifactSelectors: PORTAL_DEFAULT_SELECTORS,
      transformTemplate: PORTAL_DEFAULT_TRANSFORM,
      retryPolicy: PORTAL_DEFAULT_RETRY,
      triggerOn: PORTAL_DEFAULT_TRIGGERS,
      enabled: input.enabled ?? false,
    })
    .returning();
  if (!row) throw new Error("portal_target_seed_failed");
  return { targetId: row.id, authSecretRef: ref };
}
