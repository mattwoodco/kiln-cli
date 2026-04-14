import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as activities from "../src/activities/index.js";
import type {
  AnalyzeCodeResult,
  BuildDockerResult,
  CloneRepoResult,
  GenerateOneSheetResult,
  NormalizedLogs,
  RunTestsResult,
  StoreResultsResult,
} from "../src/activities/types.js";
import type { OneSheet } from "@kiln/shared";

/**
 * End-to-end Temporal workflow test.
 *
 * - Mocks every activity with a tracking implementation.
 * - Asserts step order: clone → (build → tests || normalize) → analyze → oneSheet → store.
 * - Verifies normalizeLogs runs in parallel with buildDocker/runTests.
 * - Verifies cohort isolation: two workflows with different rubrics produce
 *   different outputs.
 * - Verifies a usage event was emitted (via storeResults mock).
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

function makeOneSheet(overrides: Partial<OneSheet> = {}): OneSheet {
  return {
    student_id: "u1",
    cohort_id: "cohort-1",
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
      total_llm_calls: 3,
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
    ...overrides,
  };
}

interface Trace {
  events: Array<{ name: string; at: number }>;
  normalizeStarted?: number;
  normalizeEnded?: number;
  buildStarted?: number;
  runTestsEnded?: number;
  rubricYaml?: string;
  storedScore?: number;
  usageEventEmitted: boolean;
}

function buildMocks(trace: Trace): typeof activities {
  // Monotonic counter — stand in for wall-clock timing. Activities run in
  // real Node context (not the workflow sandbox) so we could use timers,
  // but the Temporal test env uses time-skipping which short-circuits them.
  let tick = 0;
  const now = (): number => ++tick;

  const cloneRepo = async (): Promise<CloneRepoResult> => {
    trace.events.push({ name: "clone", at: now() });
    return { workspacePath: "/tmp/ws", gitCloneDurationMs: 5 };
  };
  const buildDocker = async (): Promise<BuildDockerResult> => {
    trace.buildStarted = now();
    trace.events.push({ name: "build", at: trace.buildStarted });
    return { status: "ok", dockerBuildDurationMs: 40, imageRef: "img" };
  };
  const runTests = async (): Promise<RunTestsResult> => {
    trace.events.push({ name: "runTests", at: now() });
    trace.runTestsEnded = now();
    return { visible: [], hidden: null, testSuitesPassed: 1, testSuitesFailed: 0 };
  };
  const normalizeLogs = async (): Promise<NormalizedLogs> => {
    trace.normalizeStarted = now();
    trace.events.push({ name: "normalize", at: trace.normalizeStarted });
    trace.normalizeEnded = now();
    return { entryCount: 0, byKind: {}, toolUses: 0, gaps: [] };
  };
  const analyzeCode = async (): Promise<AnalyzeCodeResult> => {
    trace.events.push({ name: "analyze", at: now() });
    return {
      sonarMetrics: null,
      sonarqubeScanDurationMs: 3,
      llmFeedback: "ok",
      llmCallDetails: [],
    };
  };
  const generateOneSheet = async (input: {
    rubricYaml: string;
  }): Promise<GenerateOneSheetResult> => {
    trace.events.push({ name: "generateOneSheet", at: now() });
    trace.rubricYaml = input.rubricYaml;
    // Distinct scores per rubric content so cohort isolation is visible.
    const score = input.rubricYaml.includes("cohort-A") ? 70 : 95;
    return {
      oneSheet: makeOneSheet({ overall_score: score }),
      rubricVersion: `v-${score}`,
      promptVersion: "pv-mock",
      modelVersion: "mm-mock",
      llmCallDetails: [
        {
          call_id: "1",
          model: "claude-sonnet-4-6",
          purpose: "generate-one-sheet",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          latency_ms: 10,
          estimated_cost_usd: 0.01,
          started_at: new Date().toISOString(),
        },
      ],
    };
  };
  const storeResults = async (input: {
    oneSheet: OneSheet;
    stage: "early" | "final";
  }): Promise<StoreResultsResult> => {
    trace.events.push({ name: "store", at: now() });
    trace.storedScore = input.oneSheet.overall_score;
    trace.usageEventEmitted = true;
    return {
      gradingResultId: "gr-1",
      oneSheetArtifactPath: "/tmp/one-sheet.json",
      usageEventId: "ue-1",
      shouldDispatch: input.stage === "final",
    };
  };

  // Phase 7.5 — dispatch activity stubs. The grading workflow now starts
  // a `dispatchArtifacts` child workflow on stage="final", but in this
  // test we don't exercise it (no Portal target is registered, so the
  // child completes immediately with zero targets).
  const loadTargets = async (): Promise<never[]> => [];
  const buildPayload = async (): Promise<never> => {
    throw new Error("buildPayload should not be called when no targets");
  };
  const httpPostWithAuth = async (): Promise<never> => {
    throw new Error("httpPostWithAuth should not be called when no targets");
  };
  const recordDispatchEvent = async (): Promise<{ eventId: string }> => ({ eventId: "noop" });
  const resolveSecretActivity = async (): Promise<{ ok: false; error: string }> => ({
    ok: false,
    error: "test_no_secret",
  });
  const storeCheckpoint = async (): Promise<never> => {
    throw new Error("storeCheckpoint should not be called by grading workflow");
  };
  const generateCheckpointReport = async (): Promise<never> => {
    throw new Error("generateCheckpointReport should not be called by grading workflow");
  };
  const analyzeCodeLight = async (): Promise<never> => {
    throw new Error("analyzeCodeLight should not be called by grading workflow");
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

async function runWorkflowOnce(
  trace: Trace,
  rubricYaml: string,
): Promise<void> {
  const activitiesImpl = buildMocks(trace);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: `t-${Math.random().toString(36).slice(2, 10)}`,
    workflowsPath,
    activities: activitiesImpl,
  });
  const taskQueue = worker.options.taskQueue;
  const runPromise = worker.runUntil(async () => {
    await env.client.workflow.execute("gradeSubmission", {
      taskQueue,
      workflowId: `wf-${Math.random().toString(36).slice(2, 10)}`,
      args: [
        {
          submissionId: "sub-1",
          repoUrl: "https://example.test/repo.git",
          commitSha: "deadbeef",
          weekId: "w-1",
          cohortId: "c-1",
          userId: "u-1",
          rubricYaml,
          stage: "final",
          visibleChaosYaml: "",
          hiddenChaosYaml: "",
        },
      ],
    });
  });
  await runPromise;
}

describe("gradeSubmission workflow", () => {
  it("executes activities in dependency order and parallelizes normalize with build+tests", async () => {
    const trace: Trace = { events: [], usageEventEmitted: false };
    await runWorkflowOnce(trace, "name: cohort-A\nversion: 1\ncriteria: []");

    const names = trace.events.map((e) => e.name);
    // clone must be first, store must be last
    expect(names[0]).toBe("clone");
    expect(names[names.length - 1]).toBe("store");
    // analyze must come after runTests
    expect(names.indexOf("analyze")).toBeGreaterThan(names.indexOf("runTests"));
    // generateOneSheet must come after both analyze and normalize
    const gen = names.indexOf("generateOneSheet");
    expect(gen).toBeGreaterThan(names.indexOf("analyze"));
    expect(gen).toBeGreaterThan(names.indexOf("normalize"));

    // Parallelism check: normalizeLogs should be scheduled between clone
    // and generateOneSheet, and should interleave with build/runTests rather
    // than serialize after them. Because Promise.all fires both branches on
    // the same microtask tick, the normalize "start" index should be
    // earlier than the runTests "end" index.
    expect(trace.normalizeStarted).toBeDefined();
    expect(trace.runTestsEnded).toBeDefined();
    if (trace.normalizeStarted !== undefined && trace.runTestsEnded !== undefined) {
      expect(trace.normalizeStarted).toBeLessThanOrEqual(trace.runTestsEnded);
    }
    // normalize must be ordered before generateOneSheet
    expect(names.indexOf("normalize")).toBeLessThan(names.indexOf("generateOneSheet"));

    expect(trace.usageEventEmitted).toBe(true);
  }, 60_000);

  it("isolates cohorts: different rubrics produce different scores", async () => {
    const traceA: Trace = { events: [], usageEventEmitted: false };
    const traceB: Trace = { events: [], usageEventEmitted: false };
    await runWorkflowOnce(traceA, "name: cohort-A\nversion: 1");
    await runWorkflowOnce(traceB, "name: cohort-B\nversion: 1");
    expect(traceA.storedScore).toBe(70);
    expect(traceB.storedScore).toBe(95);
    expect(traceA.rubricYaml).toContain("cohort-A");
    expect(traceB.rubricYaml).toContain("cohort-B");
  }, 60_000);
});
