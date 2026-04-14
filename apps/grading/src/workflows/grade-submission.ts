import {
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  log,
  proxyActivities,
  startChild,
} from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { DispatchArtifactsInput } from "./dispatch-artifacts.js";

/**
 * grade-submission workflow.
 *
 * Plan ref: Phase 5 §6 (lines 832-879).
 *
 * Dependency graph:
 *   ① cloneRepo
 *   ② buildDocker        (depends on ①)
 *   ③ runTests           (depends on ②; visible chaos always, hidden only on final)
 *   ④ normalizeLogs      (depends on ①, PARALLEL with ②③ via Promise.all)
 *   ⑤ analyzeCode        (depends on ③)
 *   ⑥ generateOneSheet   (depends on ④⑤)
 *   ⑦ storeResults       (depends on ⑥)
 */

const {
  cloneRepo,
  buildDocker,
  runTests,
  normalizeLogs,
  analyzeCode,
  generateOneSheet,
  storeResults,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    maximumAttempts: 2,
  },
});

export interface GradeSubmissionInput {
  submissionId: string;
  repoUrl: string;
  commitSha: string;
  weekId: string;
  cohortId: string;
  userId: string;
  rubricYaml: string;
  stage: "early" | "final";
  visibleChaosYaml: string;
  hiddenChaosYaml: string;
}

export interface GradeSubmissionResult {
  submissionId: string;
  status: "graded" | "failed";
  oneSheetRef: string | null;
  usageEventId: string | null;
  durationMs: number;
}

export async function gradeSubmission(input: GradeSubmissionInput): Promise<GradeSubmissionResult> {
  const pipelineStartedAt = new Date().toISOString();
  const start = Date.now();

  // ① clone
  const clone = await cloneRepo({
    submissionId: input.submissionId,
    repoUrl: input.repoUrl,
    commitSha: input.commitSha,
  });

  // ②③ build + tests — and ④ normalize-logs — run in parallel.
  const [buildResult, normalized] = await Promise.all([
    (async () => {
      const build = await buildDocker({
        workspacePath: clone.workspacePath,
        submissionId: input.submissionId,
      });
      const tests = await runTests({
        workspacePath: clone.workspacePath,
        submissionId: input.submissionId,
        visibleChaosYaml: input.visibleChaosYaml,
        hiddenChaosYaml: input.hiddenChaosYaml,
        stage: input.stage,
        buildStatus: build.status,
      });
      return { build, tests };
    })(),
    normalizeLogs({ workspacePath: clone.workspacePath }),
  ]);

  // ⑤ analyze code (depends on ③)
  const analysis = await analyzeCode({
    workspacePath: clone.workspacePath,
    submissionId: input.submissionId,
    cohortId: input.cohortId,
    rubricYaml: input.rubricYaml,
    testResults: buildResult.tests,
  });

  // ⑥ generate one-sheet
  const oneSheet = await generateOneSheet({
    submissionId: input.submissionId,
    cohortId: input.cohortId,
    weekId: input.weekId,
    userId: input.userId,
    stage: input.stage,
    rubricYaml: input.rubricYaml,
    normalizedLogs: normalized,
    codeAnalysis: analysis,
    testResults: buildResult.tests,
    buildResult: buildResult.build,
  });

  // ⑦ store
  const stored = await storeResults({
    submissionId: input.submissionId,
    cohortId: input.cohortId,
    weekId: input.weekId,
    userId: input.userId,
    stage: input.stage,
    rubricYaml: input.rubricYaml,
    oneSheet: oneSheet.oneSheet,
    sonarMetrics: analysis.sonarMetrics,
    llmCallDetails: [...analysis.llmCallDetails, ...oneSheet.llmCallDetails],
    durations: {
      gitCloneMs: clone.gitCloneDurationMs,
      dockerBuildMs: buildResult.build.dockerBuildDurationMs ?? 0,
      sonarqubeScanMs: analysis.sonarqubeScanDurationMs,
    },
    pipelineStartedAt,
    rubricVersion: oneSheet.rubricVersion,
    promptVersion: oneSheet.promptVersion,
    modelVersion: oneSheet.modelVersion,
  });

  // Phase 7.5 — kick off dispatch as a fire-and-forget child workflow.
  // ParentClosePolicy.ABANDON ensures dispatch outlives this workflow's
  // close. Errors here MUST NOT fail grading — wrap in try/catch and log.
  if (stored.shouldDispatch) {
    try {
      const dispatchInput: DispatchArtifactsInput = {
        submissionId: input.submissionId,
        cohortId: input.cohortId,
        weekId: input.weekId,
        trigger: "final",
      };
      await startChild("dispatchArtifacts", {
        args: [dispatchInput],
        workflowId: `dispatch-${input.submissionId}`,
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
        cancellationType: ChildWorkflowCancellationType.ABANDON,
      });
    } catch (err) {
      log.warn("dispatch.kickoff_failed", {
        submissionId: input.submissionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    submissionId: input.submissionId,
    status: "graded",
    oneSheetRef: stored.oneSheetArtifactPath,
    usageEventId: stored.usageEventId,
    durationMs: Date.now() - start,
  };
}
