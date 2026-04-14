import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointReportSchema } from "@kiln/shared";
import { generateCheckpointReport } from "../src/activities/generate-checkpoint-report.js";
import type { AnalyzeCodeLightResult } from "../src/activities/analyze-code-light.js";
import type { BuildDockerResult, NormalizedLogs, RunTestsResult } from "../src/activities/types.js";

describe("generateCheckpointReport (MOCK_LLM)", () => {
  const original = process.env.MOCK_LLM;
  beforeEach(() => {
    process.env.MOCK_LLM = "1";
  });
  afterEach(() => {
    process.env.MOCK_LLM = original;
  });

  const baseAnalysis: AnalyzeCodeLightResult = {
    sonarMetrics: null,
    sonarqubeScanDurationMs: 3,
    llmFeedback: "mock",
    llmCallDetails: [],
  };

  const baseLogs: NormalizedLogs = { entryCount: 0, byKind: {}, toolUses: 0, gaps: [] };

  const withLogs: NormalizedLogs = {
    entryCount: 4,
    byKind: { tool_use: 2, message: 2 },
    toolUses: 2,
    gaps: [],
  };

  const okBuild: BuildDockerResult = {
    status: "ok",
    dockerBuildDurationMs: 20,
    imageRef: "img",
  };
  const missingBuild: BuildDockerResult = {
    status: "missing",
    reason: "no_dockerfile",
    affectedCriteria: ["Ships"],
  };

  const passingTests: RunTestsResult = {
    visible: [],
    hidden: null,
    testSuitesPassed: 1,
    testSuitesFailed: 0,
  };

  const baseInput = {
    submissionId: "sub-1",
    userId: "u-1",
    cohortId: "c-1",
    weekId: "w-1",
    weekNumber: 2,
    projectKey: "proj",
    rubricYaml: "name: rubric\nversion: 1\ncriteria:\n - key: ships\n",
  };

  it("validates against CheckpointReportSchema", async () => {
    const result = await generateCheckpointReport({
      ...baseInput,
      normalizedLogs: withLogs,
      codeAnalysis: baseAnalysis,
      testResults: passingTests,
      buildResult: okBuild,
    });
    const parsed = CheckpointReportSchema.parse(result.report);
    expect(parsed.overall_status).toMatch(/on-track|at-risk|not-started|blocked/);
    expect(parsed.gaps.length).toBeGreaterThan(0);
    expect(result.llmCallDetails).toHaveLength(1);
    expect(result.llmCallDetails[0]?.model).toBe("claude-sonnet-4-6");
    expect(result.llmCallDetails[0]?.purpose).toBe("checkpoint-analysis");
  });

  it("emits nullable indicative_score when evidence is missing", async () => {
    const result = await generateCheckpointReport({
      ...baseInput,
      normalizedLogs: baseLogs,
      codeAnalysis: baseAnalysis,
      testResults: null,
      buildResult: missingBuild,
    });
    const hasNull = result.report.gaps.some((g) => g.indicative_score === null);
    expect(hasNull).toBe(true);
  });

  it("uses only Sonnet (no Opus, for cost control)", async () => {
    const result = await generateCheckpointReport({
      ...baseInput,
      normalizedLogs: withLogs,
      codeAnalysis: baseAnalysis,
      testResults: passingTests,
      buildResult: okBuild,
    });
    for (const call of result.llmCallDetails) {
      expect(call.model.toLowerCase()).not.toContain("opus");
      expect(call.model).toContain("sonnet");
    }
  });

  it("coverage reflects missing build and missing tests", async () => {
    const result = await generateCheckpointReport({
      ...baseInput,
      normalizedLogs: baseLogs,
      codeAnalysis: baseAnalysis,
      testResults: null,
      buildResult: null,
    });
    expect(result.report.evaluation_coverage.docker_build).toBe("skipped");
    expect(result.report.evaluation_coverage.tests_run).toBe("skipped");
    expect(result.report.evaluation_coverage.harness_logs_present).toBe(false);
  });
});
