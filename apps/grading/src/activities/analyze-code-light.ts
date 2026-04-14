import Anthropic from "@anthropic-ai/sdk";
import type { LLMCallDetail, SonarMetrics } from "@kiln/shared";
import { loadPrompt } from "../lib/prompt-versioning.js";
import { scanWorkspace } from "../lib/sonar-scan.js";
import { trackedLLMCall } from "../lib/tracked-llm-call.js";
import type { RunTestsResult } from "./types.js";

/**
 * Reduced code-analysis activity for the checkpoint pipeline.
 *
 * Differs from `analyzeCode` in three ways:
 *   1. Uses a `checkpoint-<submissionId>` SonarQube project so it never
 *      collides with the grading pipeline.
 *   2. Single shorter Sonnet call focused on gap identification (the full
 *      grading pipeline does a 3-pass Opus synthesis).
 *   3. Called even when `testResults` is null — the checkpoint is
 *      intentionally best-effort.
 */

export interface AnalyzeCodeLightInput {
  workspacePath: string;
  submissionId: string;
  cohortId: string;
  rubricYaml: string;
  testResults: RunTestsResult | null;
}

export interface AnalyzeCodeLightResult {
  sonarMetrics: SonarMetrics | null;
  sonarqubeScanDurationMs: number;
  llmFeedback: string;
  llmCallDetails: LLMCallDetail[];
}

const SONNET_MODEL = "claude-sonnet-4-6";

export async function analyzeCodeLight(
  input: AnalyzeCodeLightInput,
): Promise<AnalyzeCodeLightResult> {
  const scan = await scanWorkspace(input.workspacePath, `checkpoint-${input.submissionId}`);

  const promptBody = await loadPrompt("code-analysis.txt");

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY ?? "mock-key-for-test-env",
  });

  const evidence = JSON.stringify(
    {
      sonarMetrics: scan.metrics,
      testResults: input.testResults
        ? {
            visibleCount: input.testResults.visible.length,
            hiddenCount: input.testResults.hidden?.length ?? null,
            suitesPassed: input.testResults.testSuitesPassed,
            suitesFailed: input.testResults.testSuitesFailed,
          }
        : null,
      rubricYamlExcerpt: input.rubricYaml.slice(0, 1500),
    },
    null,
    2,
  );

  const { detail, text } = await trackedLLMCall(
    client,
    {
      model: SONNET_MODEL,
      // Shorter budget than full grading — this is a single pass focused on
      // gap identification only, not a scored rationale.
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: `${promptBody}\n\nThis is a CHECKPOINT analysis. Identify gaps only; do NOT assign final scores.`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            `Checkpoint submission ${input.submissionId} in cohort ${input.cohortId}.`,
            `Evidence:\n${evidence}`,
            "Identify the three most pressing gaps in the code against the rubric.",
            "If any evidence is missing, explicitly name what is missing.",
          ].join("\n\n"),
        },
      ],
    },
    {
      purpose: "checkpoint-code-analysis",
      mockText:
        "mock checkpoint code analysis: three visible gaps — (1) missing Dockerfile, (2) no tests for breakers, (3) shallow error handling.",
      mockPayload: { mocked: true },
    },
  );

  return {
    sonarMetrics: scan.metrics,
    sonarqubeScanDurationMs: scan.scanDurationMs,
    llmFeedback: text,
    llmCallDetails: [detail],
  };
}
