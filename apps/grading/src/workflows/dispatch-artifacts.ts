/**
 * Phase 7.5 — dispatch-artifacts parent workflow.
 *
 * Started by `store-results` as a child workflow with
 * `ParentClosePolicy.ABANDON`, so dispatch outlives the parent grading
 * workflow's close. NEVER throws — every error is caught and logged so
 * dispatch failures cannot fail grading.
 *
 * Steps:
 *   1. loadTargets(cohortId, weekId, trigger) → DispatchTarget[]
 *   2. For each target, start dispatchSingleTarget as a child workflow
 *      in parallel. Await them all (also catching).
 *   3. Log a per-target summary; return aggregated counts.
 */

import type { DispatchTarget, DispatchTrigger } from "@kiln/shared";
import {
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  log,
  proxyActivities,
  startChild,
} from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type {
  DispatchSingleTargetInput,
  DispatchSingleTargetResult,
} from "./dispatch-single-target.js";

const { loadTargets } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

export interface DispatchArtifactsInput {
  submissionId: string;
  cohortId: string;
  weekId: string;
  trigger: DispatchTrigger;
}

export interface DispatchArtifactsResult {
  submissionId: string;
  trigger: DispatchTrigger;
  totalTargets: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  perTarget: Array<{
    targetId: string;
    name: string;
    finalStatus: DispatchSingleTargetResult["finalStatus"];
    attempts: number;
  }>;
}

export async function dispatchArtifacts(
  input: DispatchArtifactsInput,
): Promise<DispatchArtifactsResult> {
  let targets: DispatchTarget[] = [];
  try {
    targets = await loadTargets({
      cohortId: input.cohortId,
      weekId: input.weekId,
      trigger: input.trigger,
    });
  } catch (err) {
    log.warn("dispatch.load_targets_failed", {
      submissionId: input.submissionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      submissionId: input.submissionId,
      trigger: input.trigger,
      totalTargets: 0,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
      perTarget: [],
    };
  }

  if (targets.length === 0) {
    return {
      submissionId: input.submissionId,
      trigger: input.trigger,
      totalTargets: 0,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
      perTarget: [],
    };
  }

  const handles = await Promise.all(
    targets.map(async (target) => {
      const childInput: DispatchSingleTargetInput = {
        target,
        submissionId: input.submissionId,
        cohortId: input.cohortId,
      };
      const handle = await startChild("dispatchSingleTarget", {
        args: [childInput],
        workflowId: `dispatch-${input.submissionId}-${target.id}`,
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
        cancellationType: ChildWorkflowCancellationType.ABANDON,
      });
      return { target, handle };
    }),
  );

  const results: Array<{
    target: DispatchTarget;
    result: DispatchSingleTargetResult | { finalStatus: "failed"; attempts: 0; targetId: string };
  }> = [];

  for (const { target, handle } of handles) {
    try {
      const result = (await handle.result()) as DispatchSingleTargetResult;
      results.push({ target, result });
    } catch (err) {
      log.warn("dispatch.child_failed", {
        targetId: target.id,
        err: err instanceof Error ? err.message : String(err),
      });
      results.push({
        target,
        result: { finalStatus: "failed", attempts: 0, targetId: target.id },
      });
    }
  }

  let succeeded = 0;
  let failed = 0;
  let deadLettered = 0;
  for (const { result } of results) {
    if (result.finalStatus === "success") succeeded++;
    else if (result.finalStatus === "dead_letter") deadLettered++;
    else failed++;
  }

  log.info("dispatch.summary", {
    submissionId: input.submissionId,
    trigger: input.trigger,
    totalTargets: targets.length,
    succeeded,
    failed,
    deadLettered,
  });

  return {
    submissionId: input.submissionId,
    trigger: input.trigger,
    totalTargets: targets.length,
    succeeded,
    failed,
    deadLettered,
    perTarget: results.map(({ target, result }) => ({
      targetId: target.id,
      name: target.name,
      finalStatus: result.finalStatus,
      attempts: result.attempts,
    })),
  };
}
