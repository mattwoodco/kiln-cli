import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OneSheet } from "@kiln/shared";

/**
 * Phase 7.5 — dispatch isolation.
 *
 * Asserts that even if loadTargets THROWS, the parent grading workflow
 * still returns `status: "graded"`. The dispatch child workflow is
 * launched with ParentClosePolicy.ABANDON and any errors are swallowed
 * inside its own try/catch.
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

function buildActivities() {
  return {
    cloneRepo: async () => ({ workspacePath: "/tmp/ws", gitCloneDurationMs: 1 }),
    buildDocker: async () => ({
      status: "ok" as const,
      dockerBuildDurationMs: 2,
      imageRef: "img",
    }),
    runTests: async () => ({
      visible: [],
      hidden: null,
      testSuitesPassed: 1,
      testSuitesFailed: 0,
    }),
    normalizeLogs: async () => ({ entryCount: 0, byKind: {}, toolUses: 0, gaps: [] }),
    analyzeCode: async () => ({
      sonarMetrics: null,
      sonarqubeScanDurationMs: 1,
      llmFeedback: "ok",
      llmCallDetails: [],
    }),
    analyzeCodeLight: async () => {
      throw new Error("not used");
    },
    generateOneSheet: async () => ({
      oneSheet: makeOneSheet(),
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "m",
      llmCallDetails: [],
    }),
    generateCheckpointReport: async () => {
      throw new Error("not used");
    },
    storeResults: async () => ({
      gradingResultId: "gr-1",
      oneSheetArtifactPath: "/tmp/one.json",
      usageEventId: "ue-1",
      shouldDispatch: true,
    }),
    storeCheckpoint: async () => {
      throw new Error("not used");
    },
    // KEY: loadTargets ALWAYS throws — simulates a broken dispatch path.
    loadTargets: async (): Promise<never> => {
      throw new Error("simulated dispatch infra outage");
    },
    buildPayload: async () => {
      throw new Error("not used");
    },
    httpPostWithAuth: async () => {
      throw new Error("not used");
    },
    recordDispatchEvent: async () => ({ eventId: "ev" }),
    resolveSecretActivity: async () => ({ ok: false as const, error: "x" }),
  };
}

describe("dispatch isolation", () => {
  it("grading completes even when dispatch loadTargets throws", async () => {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: `iso-${Math.random().toString(36).slice(2, 10)}`,
      workflowsPath,
      activities: buildActivities(),
    });
    let result: { status: string } | null = null;
    await worker.runUntil(async () => {
      result = (await env.client.workflow.execute("gradeSubmission", {
        taskQueue: worker.options.taskQueue,
        workflowId: `iso-${Math.random().toString(36).slice(2, 10)}`,
        args: [
          {
            submissionId: "sub-iso",
            repoUrl: "https://example.test/r.git",
            commitSha: "deadbeef",
            weekId: "w-1",
            cohortId: "c-1",
            userId: "u-1",
            rubricYaml: "name: r\nversion: 1\ncriteria: []",
            stage: "final",
            visibleChaosYaml: "",
            hiddenChaosYaml: "",
          },
        ],
      })) as { status: string };
    });
    expect(result?.status).toBe("graded");
  });
});
