import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { BuildDockerResult, NormalizedLogs, RunTestsResult } from "../activities/types.js";

/**
 * checkpoint-submission workflow.
 *
 * Plan ref: Phase 6 §1 (lines 972-989).
 *
 * Reduced, best-effort pipeline for formative mid-week checkpoints. Target
 * wall-clock: <90s. The workflow MUST complete with an appropriate report
 * even when the build fails, tests cannot run, or no harness logs were
 * committed — the checkpoint's entire purpose is to surface those gaps.
 *
 * Dependency graph:
 *   ① cloneRepo
 *   ② tryBuildDocker     (depends on ①; best-effort, nullable)
 *   ③ tryRunTests        (depends on ②; best-effort, nullable)
 *   ④ normalizeLogs      (depends on ①, PARALLEL with ②③)
 *   ⑤ analyzeCodeLight   (depends on ②③④)
 *   ⑥ generateCheckpointReport (depends on ④⑤)
 *   ⑦ storeCheckpoint    (depends on ⑥)
 */

const { cloneRepo, normalizeLogs, analyzeCodeLight, generateCheckpointReport, storeCheckpoint } =
  proxyActivities<typeof activities>({
    // Tighter than grading — checkpoints target <90s end-to-end.
    startToCloseTimeout: "3 minutes",
    retry: {
      // Single retry for infra flakes, nothing fancier. Checkpoint is
      // best-effort anyway.
      maximumAttempts: 1,
    },
  });

// Build and tests get their own tighter 2-min cap (plan §1).
const { buildDocker, runTests } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export interface CheckpointSubmissionInput {
  submissionId: string;
  repoUrl: string;
  commitSha: string;
  weekId: string;
  weekNumber: number;
  cohortId: string;
  userId: string;
  projectKey: string;
  rubricYaml: string;
  /** Visible chaos profile — fed to `runTests` on checkpoint paths too. */
  visibleChaosYaml: string;
  /** When true, the stored checkpoint's `expires_at` is null (no TTL). */
  persist: boolean;
}

export interface CheckpointSubmissionResult {
  submissionId: string;
  checkpointId: string;
  reportArtifactPath: string;
  usageEventId: string;
  expiresAt: string | null;
  durationMs: number;
  status: "completed";
}

interface TryBuildAndTestsInput {
  workspacePath: string;
  submissionId: string;
  visibleChaosYaml: string;
}
interface TryBuildAndTestsResult {
  build: BuildDockerResult | null;
  tests: RunTestsResult | null;
}

async function tryBuildAndTests(args: TryBuildAndTestsInput): Promise<TryBuildAndTestsResult> {
  let build: BuildDockerResult | null = null;
  try {
    build = await buildDocker({
      workspacePath: args.workspacePath,
      submissionId: args.submissionId,
    });
  } catch {
    // Infra-level failure (e.g. docker daemon unreachable). Collapse to
    // null so the workflow keeps going.
    build = null;
  }

  let tests: RunTestsResult | null = null;
  // Only attempt tests when the build produced a usable image.
  if (build && build.status === "ok") {
    try {
      tests = await runTests({
        workspacePath: args.workspacePath,
        submissionId: args.submissionId,
        visibleChaosYaml: args.visibleChaosYaml,
        // Hidden chaos is never run on a checkpoint. Enforced here AND at
        // the API layer (the checkpoint route never forwards a hidden
        // chaos yaml).
        hiddenChaosYaml: "",
        stage: "early",
        buildStatus: build.status,
      });
    } catch {
      tests = null;
    }
  }
  return { build, tests };
}

export async function checkpointSubmission(
  input: CheckpointSubmissionInput,
): Promise<CheckpointSubmissionResult> {
  const pipelineStartedAt = new Date().toISOString();
  const start = Date.now();

  // ① clone — hard requirement. Without a workspace there is nothing to
  //    analyze at all.
  const clone = await cloneRepo({
    submissionId: input.submissionId,
    repoUrl: input.repoUrl,
    commitSha: input.commitSha,
  });

  // ②③ best-effort build + tests run in parallel with ④ normalize-logs.
  // We wrap both ② and ③ so any failure — infra, missing Dockerfile, test
  // crash — collapses to `null` and the workflow keeps going.
  const [buildAndTests, normalized]: [TryBuildAndTestsResult, NormalizedLogs] = await Promise.all([
    tryBuildAndTests({
      workspacePath: clone.workspacePath,
      submissionId: input.submissionId,
      visibleChaosYaml: input.visibleChaosYaml,
    }),
    normalizeLogs({ workspacePath: clone.workspacePath }),
  ]);

  const buildResult = buildAndTests.build;
  const testResults = buildAndTests.tests;

  // ⑤ lightweight code analysis — Sonar REST + a single short Sonnet call.
  const analysis = await analyzeCodeLight({
    workspacePath: clone.workspacePath,
    submissionId: input.submissionId,
    cohortId: input.cohortId,
    rubricYaml: input.rubricYaml,
    testResults,
  });

  // ⑥ single-pass Sonnet gap analysis.
  const generated = await generateCheckpointReport({
    submissionId: input.submissionId,
    userId: input.userId,
    cohortId: input.cohortId,
    weekId: input.weekId,
    weekNumber: input.weekNumber,
    projectKey: input.projectKey,
    rubricYaml: input.rubricYaml,
    normalizedLogs: normalized,
    codeAnalysis: analysis,
    testResults,
    buildResult,
  });

  // ⑦ persist report + usage event + artifacts.
  const stored = await storeCheckpoint({
    submissionId: input.submissionId,
    cohortId: input.cohortId,
    weekId: input.weekId,
    userId: input.userId,
    report: generated.report,
    sonarMetrics: (analysis.sonarMetrics as unknown as Record<string, unknown> | null) ?? null,
    llmCallDetails: [...analysis.llmCallDetails, ...generated.llmCallDetails],
    durations: {
      gitCloneMs: clone.gitCloneDurationMs,
      dockerBuildMs: buildResult?.dockerBuildDurationMs ?? 0,
      sonarqubeScanMs: analysis.sonarqubeScanDurationMs,
    },
    pipelineStartedAt,
    rubricVersion: generated.rubricVersion,
    promptVersion: generated.promptVersion,
    modelVersion: generated.modelVersion,
    persist: input.persist,
    // Include failed build logs as a separate artifact when available.
    partialBuildLogs: buildResult && buildResult.status === "failed" ? buildResult.logsTail : null,
  });

  return {
    submissionId: input.submissionId,
    checkpointId: stored.checkpointId,
    reportArtifactPath: stored.reportArtifactPath,
    usageEventId: stored.usageEventId,
    expiresAt: stored.expiresAt,
    durationMs: Date.now() - start,
    status: "completed",
  };
}
