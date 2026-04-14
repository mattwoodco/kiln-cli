import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OneSheet } from "@kiln/shared";
import type {
  AnalyzeCodeResult,
  BuildDockerResult,
  CloneRepoResult,
  GenerateOneSheetResult,
  NormalizedLogs,
  RunTestsResult,
  StoreResultsResult,
} from "../src/activities/types.js";

/**
 * Phase 7.5 — verifies that the dispatch child workflow is ONLY started
 * when grading is `final` stage. Early submissions and the checkpoint
 * workflow MUST NOT trigger any dispatch activity calls.
 *
 * We assert by checking the `loadTargets` mock — the parent dispatch
 * workflow ALWAYS calls loadTargets first. If the child never starts,
 * loadTargets is never called.
 */

const workflowsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/workflows",
);

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  if (env) await env.teardown();
});

function makeOneSheet(): OneSheet {
  return {
    student_id: "u-1",
    cohort_id: "c-1",
    week: 1,
    project_key: "p1",
    rubric_version: "vMock",
    overall_score: 80,
    overall_max: 100,
    overall_grade: "B",
    rubric_scores: [
      {
        criterion: "Ships",
        awarded_points: 20,
        max_points: 25,
        weight: 0.25,
        rationale: "mock",
        citations: [],
        sub_scores: [],
      },
    ],
    talking_points: [],
    ai_usage_analysis: {
      tools_used: [],
      sophistication: "basic",
      sophistication_rationale: "mock",
      total_llm_calls: 1,
      evidence: [],
    },
    evaluation_coverage: {
      files_reviewed: 0,
      files_total: 0,
      commits_reviewed: 0,
      commits_total: 0,
      harness_log_entries_considered: 0,
      sonar_included: false,
    },
    generated_at: new Date().toISOString(),
    model: "mock",
    pipeline_version: "kiln-phase5",
  };
}

interface DispatchObserved {
  loadTargetsCalled: boolean;
}

function buildActivities(observed: DispatchObserved, stage: "early" | "final") {
  return {
    cloneRepo: async (): Promise<CloneRepoResult> => ({
      workspacePath: "/tmp/ws",
      gitCloneDurationMs: 1,
    }),
    buildDocker: async (): Promise<BuildDockerResult> => ({
      status: "ok",
      dockerBuildDurationMs: 2,
      imageRef: "img",
    }),
    runTests: async (): Promise<RunTestsResult> => ({
      visible: [],
      hidden: null,
      testSuitesPassed: 1,
      testSuitesFailed: 0,
    }),
    normalizeLogs: async (): Promise<NormalizedLogs> => ({
      entryCount: 0,
      byKind: {},
      toolUses: 0,
      gaps: [],
    }),
    analyzeCode: async (): Promise<AnalyzeCodeResult> => ({
      sonarMetrics: null,
      sonarqubeScanDurationMs: 1,
      llmFeedback: "ok",
      llmCallDetails: [],
    }),
    analyzeCodeLight: async () => {
      throw new Error("not used");
    },
    generateOneSheet: async (): Promise<GenerateOneSheetResult> => ({
      oneSheet: makeOneSheet(),
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "m",
      llmCallDetails: [],
    }),
    generateCheckpointReport: async () => {
      throw new Error("not used");
    },
    storeResults: async (): Promise<StoreResultsResult> => ({
      gradingResultId: "gr-1",
      oneSheetArtifactPath: "/tmp/one.json",
      usageEventId: "ue-1",
      shouldDispatch: stage === "final",
    }),
    storeCheckpoint: async () => {
      throw new Error("not used");
    },
    loadTargets: async (): Promise<never[]> => {
      observed.loadTargetsCalled = true;
      return [];
    },
    buildPayload: async () => {
      throw new Error("not used");
    },
    httpPostWithAuth: async () => {
      throw new Error("not used");
    },
    recordDispatchEvent: async (): Promise<{ eventId: string }> => ({ eventId: "ev" }),
    resolveSecretActivity: async (): Promise<{ ok: false; error: string }> => ({
      ok: false,
      error: "not used",
    }),
  };
}

async function runGrading(stage: "early" | "final"): Promise<DispatchObserved> {
  const observed: DispatchObserved = { loadTargetsCalled: false };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: `gd-${Math.random().toString(36).slice(2, 10)}`,
    workflowsPath,
    activities: buildActivities(observed, stage),
  });
  await worker.runUntil(async () => {
    await env.client.workflow.execute("gradeSubmission", {
      taskQueue: worker.options.taskQueue,
      workflowId: `wf-${Math.random().toString(36).slice(2, 10)}`,
      args: [
        {
          submissionId: "sub-1",
          repoUrl: "https://example.test/r.git",
          commitSha: "deadbeef",
          weekId: "w-1",
          cohortId: "c-1",
          userId: "u-1",
          rubricYaml: "name: r\nversion: 1\ncriteria: []",
          stage,
          visibleChaosYaml: "",
          hiddenChaosYaml: "",
        },
      ],
    });
  });
  // The dispatch child is parent-close-policy ABANDON, so it may still be
  // running when execute() returns. Give the test env a brief moment to
  // schedule it.
  await new Promise((r) => setTimeout(r, 250));
  return observed;
}

describe("dispatch kickoff from grading workflow", () => {
  it("starts dispatch child when stage === 'final'", async () => {
    const observed = await runGrading("final");
    // Even with zero targets, the parent dispatch workflow runs and calls
    // loadTargets once.
    expect(observed.loadTargetsCalled).toBe(true);
  });

  it("does NOT start dispatch when stage === 'early'", async () => {
    const observed = await runGrading("early");
    expect(observed.loadTargetsCalled).toBe(false);
  });
});
