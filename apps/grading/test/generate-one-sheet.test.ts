import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateOneSheet } from "../src/activities/generate-one-sheet.js";
import type { AnalyzeCodeResult, GenerateOneSheetInput, RunTestsResult } from "../src/activities/types.js";

describe("generateOneSheet (MOCK_LLM)", () => {
  const original = process.env.MOCK_LLM;
  beforeEach(() => {
    process.env.MOCK_LLM = "1";
  });
  afterEach(() => {
    process.env.MOCK_LLM = original;
  });

  const baseTests: RunTestsResult = {
    visible: [],
    hidden: null,
    testSuitesPassed: 0,
    testSuitesFailed: 0,
  };
  const baseAnalysis: AnalyzeCodeResult = {
    sonarMetrics: null,
    sonarqubeScanDurationMs: 5,
    llmFeedback: "ok",
    llmCallDetails: [],
  };

  function buildInput(stage: "early" | "final", cohortId: string): GenerateOneSheetInput {
    return {
      submissionId: "00000000-0000-0000-0000-000000000010",
      cohortId,
      weekId: "00000000-0000-0000-0000-000000000020",
      userId: "00000000-0000-0000-0000-000000000030",
      stage,
      rubricYaml: `name: Cohort-${cohortId}\nversion: 1\ncriteria:\n  - key: ships\n`,
      normalizedLogs: { entryCount: 0, byKind: {}, toolUses: 0, gaps: [] },
      codeAnalysis: baseAnalysis,
      testResults: baseTests,
      buildResult: { status: "ok", dockerBuildDurationMs: 1, imageRef: "kiln-x" },
    };
  }

  it("runs 3 LLM passes and captures 3 detail records", async () => {
    const out = await generateOneSheet(buildInput("final", "cohort-A"));
    expect(out.llmCallDetails).toHaveLength(3);
    expect(out.oneSheet.overall_score).toBeGreaterThan(0);
    // Pass 3 must validate against OneSheetSchema (if not, zod throws)
    expect(out.oneSheet.rubric_scores.length).toBeGreaterThan(0);
  });

  it("uses the cohort-specific rubric to compute a rubric_version hash", async () => {
    const a = await generateOneSheet(buildInput("final", "cohort-A"));
    const b = await generateOneSheet(buildInput("final", "cohort-B"));
    // Same rubric body (aside from the cohort name embedded) → differentiates hashes
    expect(a.rubricVersion).not.toBe(b.rubricVersion);
  });

  it("tags resilience as dress_rehearsal on stage=early", async () => {
    const out = await generateOneSheet(buildInput("early", "cohort-C"));
    const resilience = out.oneSheet.rubric_scores.find((s) => s.criterion === "Resilience");
    expect(resilience?.rationale).toMatch(/dress_rehearsal/);
  });
});
