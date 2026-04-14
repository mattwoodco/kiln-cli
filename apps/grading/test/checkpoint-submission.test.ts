import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as activities from "../src/activities/index.js";
import type {
  AnalyzeCodeLightResult,
  BuildDockerResult,
  CloneRepoResult,
  NormalizedLogs,
  RunTestsResult,
  StoreCheckpointResult,
} from "../src/activities/index.js";
import type { CheckpointSubmissionInput } from "../src/workflows/checkpoint-submission.js";
import type {
  CheckpointReport,
  CheckpointEvaluationCoverage,
} from "@kiln/shared";

/**
 * End-to-end Temporal workflow test for `checkpointSubmission`.
 *
 * Permutations cover every combination of partial evidence:
 *   (a) complete project — build ok, tests ok, harness logs present
 *   (b) build missing    — Dockerfile absent
 *   (c) build ok, tests fail
 *   (d) no harness logs
 *   (e) everything missing
 *
 * Every permutation MUST produce a valid CheckpointReport with the correct
 * `evaluation_coverage` flags. The workflow must never throw.
 */

// Unused — kept as a typecheck reference for the workflow input shape.
type _InputShape = CheckpointSubmissionInput;

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

function makeMockReport(coverage: CheckpointEvaluationCoverage): CheckpointReport {
  return {
    student_id: "u-1",
    cohort_id: "c-1",
    week: 1,
    project_key: "proj",
    checkpoint_kind: "mid-week",
    generated_at: new Date().toISOString(),
    overall_status: coverage.docker_build === "ok" ? "on-track" : "at-risk",
    overall_summary: "mock summary",
    gaps: [
      {
        criterion: "Ships",
        status: coverage.docker_build === "ok" ? "on-track" : "at-risk",
        indicative_score: coverage.docker_build === "ok" ? 20 : null,
        max_points: 25,
        recommendations: [],
        evidence: [],
        summary: "mock gap",
      },
    ],
    evaluation_coverage: coverage,
    ai_usage_snapshot: {
      total_llm_calls: 0,
      distinct_tools: [],
      sophistication: null,
    },
    top_priorities: [],
    commits_considered: 0,
    harness_entries_considered: coverage.harness_logs_present ? 3 : 0,
    model: "claude-sonnet-4-6",
    pipeline_version: "kiln-phase6-checkpoint",
  };
}

interface ScenarioInput {
  build: BuildDockerResult | "throw";
  tests: RunTestsResult | "throw" | null;
  logs: NormalizedLogs;
}

interface Observed {
  reportCoverage?: CheckpointEvaluationCoverage;
  buildCalled: boolean;
  testsCalled: boolean;
  analyzeCalled: boolean;
  generateCalled: boolean;
  storeCalled: boolean;
  storePersistFlag: boolean | null;
}

function buildMocks(
  scenario: ScenarioInput,
  observed: Observed,
): typeof activities {
  const cloneRepo = async (): Promise<CloneRepoResult> => ({
    workspacePath: "/tmp/ws",
    gitCloneDurationMs: 5,
  });
  const buildDocker = async (): Promise<BuildDockerResult> => {
    observed.buildCalled = true;
    if (scenario.build === "throw") throw new Error("docker_daemon_unreachable");
    return scenario.build;
  };
  const runTests = async (): Promise<RunTestsResult> => {
    observed.testsCalled = true;
    if (scenario.tests === "throw") throw new Error("test_runner_crashed");
    if (scenario.tests === null) {
      // Simulate "no tests" by failing — workflow should catch.
      throw new Error("no tests");
    }
    return scenario.tests;
  };
  const normalizeLogs = async (): Promise<NormalizedLogs> => scenario.logs;
  const analyzeCode = async (): Promise<activities.AnalyzeCodeResult> => {
    throw new Error("analyzeCode should not be called by checkpoint workflow");
  };
  const analyzeCodeLight = async (input: {
    testResults: RunTestsResult | null;
  }): Promise<AnalyzeCodeLightResult> => {
    observed.analyzeCalled = true;
    return {
      sonarMetrics: null,
      sonarqubeScanDurationMs: 1,
      llmFeedback: "mock light analysis",
      llmCallDetails: [
        {
          call_id: "ck-1",
          model: "claude-sonnet-4-6",
          purpose: "checkpoint-code-analysis",
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          latency_ms: 5,
          estimated_cost_usd: 0.0001,
          started_at: new Date().toISOString(),
        },
      ],
    };
  };
  const generateOneSheet = async (): Promise<activities.GenerateOneSheetResult> => {
    throw new Error("generateOneSheet should not be called by checkpoint workflow");
  };
  const generateCheckpointReport = async (input: {
    buildResult: BuildDockerResult | null;
    testResults: RunTestsResult | null;
    normalizedLogs: NormalizedLogs;
  }): Promise<activities.GenerateCheckpointReportResult> => {
    observed.generateCalled = true;
    const coverage: CheckpointEvaluationCoverage = {
      docker_build:
        input.buildResult === null
          ? "skipped"
          : input.buildResult.status === "ok"
            ? "ok"
            : input.buildResult.status === "missing"
              ? "missing"
              : "failed",
      tests_run:
        input.testResults === null
          ? "skipped"
          : input.testResults.testSuitesFailed > 0
            ? "failed"
            : "ok",
      harness_logs_present: input.normalizedLogs.entryCount > 0,
      sonar_included: false,
      files_considered: 0,
    };
    const report = makeMockReport(coverage);
    observed.reportCoverage = coverage;
    return {
      report,
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "claude-sonnet-4-6",
      llmCallDetails: [
        {
          call_id: "ck-2",
          model: "claude-sonnet-4-6",
          purpose: "checkpoint-analysis",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          latency_ms: 10,
          estimated_cost_usd: 0.001,
          started_at: new Date().toISOString(),
        },
      ],
    };
  };
  const storeResults = async (): Promise<activities.StoreResultsResult> => {
    throw new Error("storeResults should not be called by checkpoint workflow");
  };
  const storeCheckpoint = async (input: {
    persist: boolean;
  }): Promise<StoreCheckpointResult> => {
    observed.storeCalled = true;
    observed.storePersistFlag = input.persist;
    return {
      checkpointId: "cp-1",
      reportArtifactPath: "/tmp/report.json",
      usageEventId: "ue-1",
      expiresAt: input.persist ? null : new Date(Date.now() + 7 * 86400_000).toISOString(),
    };
  };

  // Phase 7.5 dispatch stubs — checkpoint workflow MUST NOT call any of these.
  const loadTargets = async (): Promise<never> => {
    throw new Error("loadTargets should not be called by checkpoint workflow");
  };
  const buildPayload = async (): Promise<never> => {
    throw new Error("buildPayload should not be called by checkpoint workflow");
  };
  const httpPostWithAuth = async (): Promise<never> => {
    throw new Error("httpPostWithAuth should not be called by checkpoint workflow");
  };
  const recordDispatchEvent = async (): Promise<never> => {
    throw new Error("recordDispatchEvent should not be called by checkpoint workflow");
  };
  const resolveSecretActivity = async (): Promise<never> => {
    throw new Error("resolveSecretActivity should not be called by checkpoint workflow");
  };

  return {
    cloneRepo,
    buildDocker,
    runTests,
    normalizeLogs,
    analyzeCode,
    analyzeCodeLight,
    generateOneSheet,
    generateCheckpointReport,
    storeResults,
    storeCheckpoint,
    loadTargets,
    buildPayload,
    httpPostWithAuth,
    recordDispatchEvent,
    resolveSecretActivity,
  };
}

async function runScenario(scenario: ScenarioInput, persist = false): Promise<Observed> {
  const observed: Observed = {
    buildCalled: false,
    testsCalled: false,
    analyzeCalled: false,
    generateCalled: false,
    storeCalled: false,
    storePersistFlag: null,
  };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: `cp-${Math.random().toString(36).slice(2, 10)}`,
    workflowsPath,
    activities: buildMocks(scenario, observed),
  });
  await worker.runUntil(async () => {
    await env.client.workflow.execute("checkpointSubmission", {
      taskQueue: worker.options.taskQueue,
      workflowId: `wfcp-${Math.random().toString(36).slice(2, 10)}`,
      args: [
        {
          submissionId: "s-1",
          repoUrl: "https://example.test/repo.git",
          commitSha: "deadbeef",
          weekId: "w-1",
          weekNumber: 1,
          cohortId: "c-1",
          userId: "u-1",
          projectKey: "proj",
          rubricYaml: "name: rubric\nversion: 1\ncriteria: []",
          visibleChaosYaml: "",
          persist,
        },
      ],
    });
  });
  return observed;
}

const OK_BUILD: BuildDockerResult = { status: "ok", dockerBuildDurationMs: 10, imageRef: "img" };
const MISSING_BUILD: BuildDockerResult = {
  status: "missing",
  reason: "no_dockerfile",
  affectedCriteria: ["Ships"],
  dockerBuildDurationMs: 1,
};
const PASSING_TESTS: RunTestsResult = {
  visible: [],
  hidden: null,
  testSuitesPassed: 1,
  testSuitesFailed: 0,
};
const FAILING_TESTS: RunTestsResult = {
  visible: [],
  hidden: null,
  testSuitesPassed: 0,
  testSuitesFailed: 1,
};
const WITH_LOGS: NormalizedLogs = {
  entryCount: 5,
  byKind: { tool_use: 3, message: 2 },
  toolUses: 3,
  gaps: [],
};
const NO_LOGS: NormalizedLogs = {
  entryCount: 0,
  byKind: {},
  toolUses: 0,
  gaps: ["no_harness_logs_present"],
};

describe("checkpointSubmission workflow", () => {
  it("(a) complete project — build ok, tests ok, logs present", async () => {
    const obs = await runScenario({ build: OK_BUILD, tests: PASSING_TESTS, logs: WITH_LOGS });
    expect(obs.storeCalled).toBe(true);
    expect(obs.reportCoverage?.docker_build).toBe("ok");
    expect(obs.reportCoverage?.tests_run).toBe("ok");
    expect(obs.reportCoverage?.harness_logs_present).toBe(true);
    expect(obs.storePersistFlag).toBe(false);
  }, 60_000);

  it("(b) no Dockerfile — docker_build='missing', tests skipped", async () => {
    const obs = await runScenario({ build: MISSING_BUILD, tests: null, logs: WITH_LOGS });
    expect(obs.storeCalled).toBe(true);
    expect(obs.reportCoverage?.docker_build).toBe("missing");
    expect(obs.reportCoverage?.tests_run).toBe("skipped");
  }, 60_000);

  it("(c) build ok, tests throw — tests_run='skipped'", async () => {
    const obs = await runScenario({ build: OK_BUILD, tests: "throw", logs: WITH_LOGS });
    expect(obs.storeCalled).toBe(true);
    expect(obs.reportCoverage?.tests_run).toBe("skipped");
  }, 60_000);

  it("(d) no harness logs", async () => {
    const obs = await runScenario({ build: OK_BUILD, tests: PASSING_TESTS, logs: NO_LOGS });
    expect(obs.storeCalled).toBe(true);
    expect(obs.reportCoverage?.harness_logs_present).toBe(false);
  }, 60_000);

  it("(e) everything missing: docker throws, no tests, no logs", async () => {
    const obs = await runScenario({ build: "throw", tests: null, logs: NO_LOGS });
    expect(obs.storeCalled).toBe(true);
    expect(obs.reportCoverage?.docker_build).toBe("skipped");
    expect(obs.reportCoverage?.tests_run).toBe("skipped");
    expect(obs.reportCoverage?.harness_logs_present).toBe(false);
  }, 60_000);

  it("propagates persist flag to storeCheckpoint", async () => {
    const obs = await runScenario(
      { build: OK_BUILD, tests: PASSING_TESTS, logs: WITH_LOGS },
      true,
    );
    expect(obs.storePersistFlag).toBe(true);
  }, 60_000);

  it("never calls grading-pipeline activities", async () => {
    const obs = await runScenario({ build: OK_BUILD, tests: PASSING_TESTS, logs: WITH_LOGS });
    expect(obs.analyzeCalled).toBe(true);
    expect(obs.generateCalled).toBe(true);
    // No assertions on analyzeCode/generateOneSheet/storeResults — the
    // mocks throw if called, so if we got here they weren't invoked.
  }, 60_000);

  it("failing tests path — tests_run='failed'", async () => {
    const obs = await runScenario({ build: OK_BUILD, tests: FAILING_TESTS, logs: WITH_LOGS });
    expect(obs.reportCoverage?.tests_run).toBe("failed");
  }, 60_000);
});
