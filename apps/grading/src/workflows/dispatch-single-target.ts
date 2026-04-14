/**
 * Phase 7.5 — dispatch-single-target child workflow.
 *
 * Retry loop for one target. The activity calls themselves are retried
 * inside Temporal as well, but the BUSINESS retry semantics (4xx → no
 * retry, 5xx/429/network → backoff and retry) live in this workflow.
 *
 * SECURITY:
 *   - Resolves the secret via an activity. The secret value is NEVER
 *     passed back into payload, log line, or DB row.
 *   - The activity that performs the HTTP POST takes the secret as an
 *     in-memory argument; Temporal stores activity input in workflow
 *     history, so we accept the trade-off (single-tenant, encrypted
 *     history at rest). DEFERRED: encrypted DataConverter.
 *
 * Terminal statuses recorded in dispatch_events:
 *   success     — 2xx response
 *   failed      — 4xx (non-429) — short-circuits retry
 *   dead_letter — exhausted maxAttempts
 */

import type { DispatchEventStatus, DispatchTarget } from "@kiln/shared";
import { ApplicationFailure, log, proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { buildPayload, httpPostWithAuth, recordDispatchEvent } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 1, // business retry lives in this workflow, not the activity
  },
});

// Secret resolution runs as an activity so the workflow code itself is
// deterministic (no env access from workflow).
const { resolveSecretActivity } = proxyActivities<{
  resolveSecretActivity(
    ref: string | null,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
}>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 1 },
});

export interface DispatchSingleTargetInput {
  target: DispatchTarget;
  submissionId: string;
  cohortId: string;
}

export interface DispatchSingleTargetResult {
  targetId: string;
  finalStatus: DispatchEventStatus;
  attempts: number;
  responseRef: string | null;
}

function classify(httpStatus: number, hasError: boolean): "success" | "client_error" | "transient" {
  if (httpStatus >= 200 && httpStatus < 300) return "success";
  if (httpStatus === 429) return "transient";
  if (httpStatus >= 400 && httpStatus < 500) return "client_error";
  if (httpStatus >= 500) return "transient";
  if (hasError) return "transient"; // network / timeout
  return "transient";
}

/**
 * Pluck a Portal-style responseRef from a JSON response body. Lives in the
 * workflow file (rather than the Portal target shaper) so we don't bloat
 * the workflow bundle with the seedPortalTarget helper.
 */
function extractResponseRef(body: string): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { job_id?: unknown; interview_id?: unknown };
      if (typeof obj.job_id === "string" && obj.job_id.length > 0) return obj.job_id;
      if (typeof obj.interview_id === "string" && obj.interview_id.length > 0) {
        return obj.interview_id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function dispatchSingleTarget(
  input: DispatchSingleTargetInput,
): Promise<DispatchSingleTargetResult> {
  const { target } = input;

  // 1. Build payload (also size-caps + redacts).
  let payload: unknown;
  let payloadBytes = 0;
  try {
    const built = await buildPayload({
      submissionId: input.submissionId,
      cohortId: input.cohortId,
      selectors: target.artifactSelectors,
      transformTemplate: target.transformTemplate,
    });
    payload = built.payload;
    payloadBytes = built.payloadBytes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("dispatch.build_payload_failed", { targetId: target.id, msg });
    await recordDispatchEvent({
      targetId: target.id,
      submissionId: input.submissionId,
      cohortId: input.cohortId,
      attempt: 1,
      status: "failed",
      httpStatus: null,
      latencyMs: null,
      error: `build_payload: ${msg}`,
      payloadBytes: 0,
      responseRef: null,
    });
    return { targetId: target.id, finalStatus: "failed", attempts: 1, responseRef: null };
  }

  // 2. Resolve secret if needed.
  let secret: string | null = null;
  if (target.authMode !== "none") {
    const resolved = await resolveSecretActivity(target.authSecretRef);
    if (!resolved.ok) {
      log.warn("dispatch.secret_unresolved", {
        targetId: target.id,
        // NOTE: only the ref is logged, never the value. We never even hold a value.
        authSecretRef: target.authSecretRef,
      });
      await recordDispatchEvent({
        targetId: target.id,
        submissionId: input.submissionId,
        cohortId: input.cohortId,
        attempt: 1,
        status: "failed",
        httpStatus: null,
        latencyMs: null,
        error: resolved.error,
        payloadBytes,
        responseRef: null,
      });
      return { targetId: target.id, finalStatus: "failed", attempts: 1, responseRef: null };
    }
    secret = resolved.value;
  }

  // 3. Retry loop.
  const maxAttempts = target.retryPolicy.maxAttempts;
  const backoff = target.retryPolicy.backoffSeconds;
  let lastStatus: DispatchEventStatus = "pending";
  let lastResponseRef: string | null = null;
  let attempt = 0;

  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    const httpResult = await httpPostWithAuth({
      url: target.url,
      authMode: target.authMode,
      secret,
      payload,
    });

    const verdict = classify(httpResult.httpStatus, !!httpResult.error);
    const responseRef = verdict === "success" ? extractResponseRef(httpResult.responseBody) : null;
    const errForRow = httpResult.error ?? null;

    if (verdict === "success") {
      lastStatus = "success";
      lastResponseRef = responseRef;
      await recordDispatchEvent({
        targetId: target.id,
        submissionId: input.submissionId,
        cohortId: input.cohortId,
        attempt,
        status: "success",
        httpStatus: httpResult.httpStatus,
        latencyMs: httpResult.latencyMs,
        error: null,
        payloadBytes,
        responseRef,
      });
      break;
    }

    if (verdict === "client_error") {
      lastStatus = "failed";
      await recordDispatchEvent({
        targetId: target.id,
        submissionId: input.submissionId,
        cohortId: input.cohortId,
        attempt,
        status: "failed",
        httpStatus: httpResult.httpStatus,
        latencyMs: httpResult.latencyMs,
        error: errForRow ?? `http_${httpResult.httpStatus}`,
        payloadBytes,
        responseRef: null,
      });
      break;
    }

    // Transient: record retrying row, sleep, continue.
    const isLast = attempt >= maxAttempts;
    const status: DispatchEventStatus = isLast ? "dead_letter" : "retrying";
    await recordDispatchEvent({
      targetId: target.id,
      submissionId: input.submissionId,
      cohortId: input.cohortId,
      attempt,
      status,
      httpStatus: httpResult.httpStatus || null,
      latencyMs: httpResult.latencyMs,
      error: errForRow ?? `http_${httpResult.httpStatus}`,
      payloadBytes,
      responseRef: null,
    });
    lastStatus = status;
    if (isLast) break;
    const sleepSecs = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 1;
    await sleep(`${sleepSecs} seconds`);
  }

  // Defensive: if the loop somehow exits without a terminal row, ensure we
  // surface a dead_letter (should be unreachable).
  if (lastStatus !== "success" && lastStatus !== "failed" && lastStatus !== "dead_letter") {
    throw ApplicationFailure.create({
      message: "dispatch_loop_invariant_violated",
      type: "dispatch_loop_invariant",
      nonRetryable: true,
    });
  }

  return {
    targetId: target.id,
    finalStatus: lastStatus,
    attempts: attempt,
    responseRef: lastResponseRef,
  };
}
