import Anthropic from "@anthropic-ai/sdk";
import { loadPrompt } from "../lib/prompt-versioning.js";
import { scanWorkspace } from "../lib/sonar-scan.js";
import { trackedLLMCall } from "../lib/tracked-llm-call.js";
import type { AnalyzeCodeInput, AnalyzeCodeResult } from "./types.js";

/**
 * SonarQube + LLM hybrid code analysis.
 *
 * Plan §5 step 7:
 *   a) Run sonar-scanner against the workspace
 *   b) Parse metrics into SonarMetricsSchema
 *   c) Call Claude Sonnet via trackedLLMCall() with metrics + code + rubric
 *   d) Delete the ephemeral Sonar project
 *
 * DEFERRED: actual sonar-scanner CLI invocation. We probe SonarQube via its
 * REST API (see `lib/sonar-scan.ts`); when scanner or Sonar is unreachable,
 * we return `sonarMetrics: null` and continue. Phase 4 / runner host will
 * wire a real scanner.
 */

export async function analyzeCode(input: AnalyzeCodeInput): Promise<AnalyzeCodeResult> {
  const scan = await scanWorkspace(input.workspacePath, `submission-${input.submissionId}`);

  const promptBody = await loadPrompt("code-analysis.txt");

  // We don't have a real Anthropic SDK handle in MOCK_LLM mode. The
  // `trackedLLMCall` helper short-circuits before using the client, so we
  // pass a zeroed instance that satisfies the type system.
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY ?? "mock-key-for-test-env",
  });

  const codeEvidence = JSON.stringify(
    {
      sonarMetrics: scan.metrics,
      testResults: input.testResults,
      rubricYamlExcerpt: input.rubricYaml.slice(0, 2000),
    },
    null,
    2,
  );

  const { detail, text } = await trackedLLMCall(
    client,
    {
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: promptBody,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Submission ${input.submissionId} in cohort ${input.cohortId}. Evidence:\n${codeEvidence}`,
        },
      ],
    },
    {
      purpose: "analyze-code",
      mockText: "mock code analysis: within acceptable bounds per Sonar metrics and tests.",
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
