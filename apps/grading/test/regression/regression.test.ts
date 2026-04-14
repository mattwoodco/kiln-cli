/**
 * Phase 8 — Grading regression suite.
 *
 * For each gold-set submission:
 *   - Runs `generateOneSheet` via the MOCK_LLM deterministic path so the
 *     test is hermetic (no ANTHROPIC_API_KEY required).
 *   - Asserts schema validity of the Pass 3 synthesis output.
 *   - Verifies the ±5 drift contract shape via a DEFERRED comment — the
 *     mock path is deterministic so drift is trivially zero. The real
 *     drift check requires REAL_LLM=1 + a live ANTHROPIC_API_KEY and is
 *     not run in CI (see gold-set/README.md).
 *   - Asserts rubric_version differentiates between cohort rubrics.
 *
 * Run locally:
 *   bun test apps/grading/test/regression/regression.test.ts
 * or via the project filter:
 *   bunx vitest --project regression
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateOneSheet } from "../../src/activities/generate-one-sheet.js";
import type {
  AnalyzeCodeResult,
  GenerateOneSheetInput,
  RunTestsResult,
} from "../../src/activities/types.js";
import { type GoldSetSubmission, loadGoldSet } from "./gold-set/index.js";

describe("grading regression — gold-set (MOCK_LLM)", () => {
  const originalMock = process.env.MOCK_LLM;
  let goldSet: { submissions: GoldSetSubmission[] };

  beforeAll(async () => {
    process.env.MOCK_LLM = "1";
    goldSet = await loadGoldSet();
  });

  afterAll(() => {
    if (originalMock === undefined) {
      delete process.env.MOCK_LLM;
    } else {
      process.env.MOCK_LLM = originalMock;
    }
  });

  function buildInput(sub: GoldSetSubmission): GenerateOneSheetInput {
    const testResults: RunTestsResult = {
      visible: [],
      hidden: sub.testResults.hiddenCount === null ? null : [],
      testSuitesPassed: sub.testResults.testSuitesPassed,
      testSuitesFailed: sub.testResults.testSuitesFailed,
    };
    const codeAnalysis: AnalyzeCodeResult = {
      sonarMetrics: null,
      sonarqubeScanDurationMs: 1,
      llmFeedback: `mock analysis for ${sub.id}`,
      llmCallDetails: [],
    };
    return {
      submissionId: `00000000-0000-0000-0000-${sub.id.slice(0, 12).padEnd(12, "0")}`,
      cohortId: `00000000-0000-0000-0000-${sub.cohortName.slice(0, 12).padEnd(12, "0")}`,
      weekId: `00000000-0000-0000-0000-${String(sub.weekNumber).padStart(12, "0")}`,
      userId: "00000000-0000-0000-0000-000000000001",
      stage: sub.stage,
      rubricYaml: sub.rubricYaml,
      normalizedLogs: sub.normalizedLogs,
      codeAnalysis,
      testResults,
      buildResult: { status: "ok", dockerBuildDurationMs: 100, imageRef: `gs-${sub.id}` },
    };
  }

  it("loads manifest and resolves at least one submission per rubric", async () => {
    const rubrics = new Set(goldSet.submissions.map((s) => s.rubricVersion));
    expect(goldSet.submissions.length).toBeGreaterThanOrEqual(6);
    expect(rubrics.size).toBeGreaterThanOrEqual(2);
  });

  // Per-submission shape + citation + tools check.
  it("each gold-set submission produces a schema-valid OneSheet", async () => {
    for (const sub of goldSet.submissions) {
      const result = await generateOneSheet(buildInput(sub));

      // 5 rubric scores.
      expect(
        result.oneSheet.rubric_scores,
        `${sub.id} must have 5 rubric scores`,
      ).toHaveLength(5);

      // ±5 drift assertion.
      // DEFERRED: real ±5 drift check requires live LLM + ANTHROPIC_API_KEY —
      // run manually via `REAL_LLM=1 bun test apps/grading/test/regression/regression.test.ts`.
      // With MOCK_LLM=1 the mock produces a fixed deterministic score
      // vector that does NOT vary per submission, so we cannot drift-check
      // it against the human-graded expected_scores spread. We still
      // exercise the shape assertion (criterion keys present with sane
      // numeric bounds) so future regressions of the mock OR real
      // pipeline output are caught.
      const realLlm = process.env.REAL_LLM === "1";
      for (const criterion of result.oneSheet.rubric_scores) {
        expect(criterion.awarded_points).toBeGreaterThanOrEqual(0);
        expect(criterion.awarded_points).toBeLessThanOrEqual(criterion.max_points);
        if (realLlm) {
          const key = criterion.criterion as keyof typeof sub.expectedScores;
          const expected = sub.expectedScores[key];
          if (expected !== undefined) {
            expect(criterion.awarded_points).toBeGreaterThanOrEqual(expected - 5);
            expect(criterion.awarded_points).toBeLessThanOrEqual(expected + 5);
          }
        }
      }

      // Every talking point has at least one citation.
      for (const tp of result.oneSheet.talking_points) {
        expect(
          tp.citations.length,
          `${sub.id} talking point "${tp.title}" must have at least one citation`,
        ).toBeGreaterThanOrEqual(1);
      }

      // ai_usage_analysis has at least one tool recorded.
      expect(
        result.oneSheet.ai_usage_analysis.tools_used.length,
        `${sub.id} ai_usage_analysis must include at least one tool`,
      ).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  it("different cohort rubrics produce different rubric_version hashes", async () => {
    const byRubric = new Map<string, GoldSetSubmission>();
    for (const sub of goldSet.submissions) {
      if (!byRubric.has(sub.rubricVersion)) byRubric.set(sub.rubricVersion, sub);
    }
    const picks = [...byRubric.values()].slice(0, 2);
    expect(picks.length).toBeGreaterThanOrEqual(2);
    const resultA = await generateOneSheet(buildInput(picks[0]!));
    const resultB = await generateOneSheet(buildInput(picks[1]!));
    // The generated-one-sheet top-level rubricVersion is a hash of the
    // rubric YAML — two cohorts with different weights must differ.
    expect(resultA.rubricVersion).not.toBe(resultB.rubricVersion);
  }, 120_000);
});
