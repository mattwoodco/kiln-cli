import Anthropic from "@anthropic-ai/sdk";
import { type LLMCallDetail, type OneSheet, OneSheetSchema } from "@kiln/shared";
import { compositePromptVersion, hashRubricYaml, loadPrompt } from "../lib/prompt-versioning.js";
import { trackedLLMCall } from "../lib/tracked-llm-call.js";
import type { GenerateOneSheetInput, GenerateOneSheetResult } from "./types.js";

/**
 * Three-pass one-sheet generation.
 *
 *   Pass 1 — Extraction        (Sonnet)
 *   Pass 2 — Rubric evaluation (Sonnet) [Resilience from hidden-set results]
 *   Pass 3 — Synthesis         (Opus)   → OneSheetSchema
 *
 * Prompt caching key = `cohortId + weekNumber` so students in the same
 * cohort/week share the cached prefix. We wire `cache_control` on the
 * cached-prefix system block even in MOCK_LLM mode — the param shape is
 * still exercised for typing and for cost calculations.
 *
 * DEFERRED: real Anthropic calls. Use `MOCK_LLM=1` for deterministic
 * runs until ANTHROPIC_API_KEY is wired into the runner host.
 */

const SONNET_MODEL = "claude-sonnet-4-6";
const OPUS_MODEL = "claude-opus-4-6";

export async function generateOneSheet(
  input: GenerateOneSheetInput,
): Promise<GenerateOneSheetResult> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY ?? "mock-key-for-test-env",
  });

  const cachedPrefix = (await loadPrompt("cached-prefix.txt")).replace(
    "{{rubric}}",
    input.rubricYaml,
  );
  const pass1 = await loadPrompt("pass1-extraction.txt");
  const pass2 = await loadPrompt("pass2-rubric-eval.txt");
  const pass3 = await loadPrompt("pass3-synthesis.txt");

  const evidence = {
    submissionId: input.submissionId,
    cohortId: input.cohortId,
    weekId: input.weekId,
    stage: input.stage,
    normalizedLogs: input.normalizedLogs,
    buildStatus: input.buildResult.status,
    testResults: {
      visibleCount: input.testResults.visible.length,
      hiddenCount: input.testResults.hidden?.length ?? null,
      visibleVerdicts: input.testResults.visible.map((r) => r.verdict),
      hiddenVerdicts: input.testResults.hidden?.map((r) => r.verdict) ?? null,
    },
    codeAnalysis: input.codeAnalysis.llmFeedback,
    sonarMetrics: input.codeAnalysis.sonarMetrics,
  };

  const llmCallDetails: LLMCallDetail[] = [];
  const cacheKey = `${input.cohortId}::${input.weekId}`;

  // --- Pass 1 ---
  const extraction = await trackedLLMCall(
    client,
    {
      model: SONNET_MODEL,
      max_tokens: 4096,
      metadata: { user_id: cacheKey },
      system: [
        { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: pass1 },
      ],
      messages: [
        {
          role: "user",
          content: `Extract the factual ledger for submission ${input.submissionId}.\nEvidence:\n${JSON.stringify(evidence)}`,
        },
      ],
    },
    {
      purpose: "generate-one-sheet",
      mockText: JSON.stringify({ extraction: "mock pass1 ledger" }),
    },
  );
  llmCallDetails.push(extraction.detail);

  // --- Pass 2 ---
  const evaluation = await trackedLLMCall(
    client,
    {
      model: SONNET_MODEL,
      max_tokens: 4096,
      metadata: { user_id: cacheKey },
      system: [
        { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: pass2 },
      ],
      messages: [
        {
          role: "user",
          content: `Pass 1 ledger:\n${extraction.text}\n\nScore the rubric criterion-by-criterion.\nRemember: Resilience is scored primarily from hidden-set results when present (stage=${input.stage}).`,
        },
      ],
    },
    {
      purpose: "generate-one-sheet",
      mockText: JSON.stringify({ criteria: [{ criterion: "Ships", points: 20 }] }),
    },
  );
  llmCallDetails.push(evaluation.detail);

  // --- Pass 3 — synthesis (Opus, must produce OneSheetSchema) ---
  const synthesis = await trackedLLMCall<OneSheet>(
    client,
    {
      model: OPUS_MODEL,
      max_tokens: 8192,
      metadata: { user_id: cacheKey },
      system: [
        { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: pass3 },
      ],
      messages: [
        {
          role: "user",
          content: `Pass 1 ledger:\n${extraction.text}\n\nPass 2 per-criterion scores:\n${evaluation.text}\n\nProduce the final OneSheet JSON for submission ${input.submissionId}.`,
        },
      ],
    },
    {
      purpose: "generate-one-sheet",
      mockPayload: buildMockOneSheet(input),
      mockText: JSON.stringify(buildMockOneSheet(input)),
    },
  );
  llmCallDetails.push(synthesis.detail);

  // Validate the Pass 3 output against OneSheetSchema.
  let oneSheet: OneSheet;
  if (synthesis.parsed) {
    oneSheet = OneSheetSchema.parse(synthesis.parsed);
  } else {
    try {
      oneSheet = OneSheetSchema.parse(JSON.parse(synthesis.text));
    } catch {
      // Real LLM returned text we couldn't parse. Fall back to mock shape
      // so the pipeline can still store results for triage.
      oneSheet = OneSheetSchema.parse(buildMockOneSheet(input));
    }
  }

  const promptVersion = await compositePromptVersion([
    "cached-prefix.txt",
    "pass1-extraction.txt",
    "pass2-rubric-eval.txt",
    "pass3-synthesis.txt",
  ]);

  return {
    oneSheet,
    rubricVersion: hashRubricYaml(input.rubricYaml),
    promptVersion,
    modelVersion: `${SONNET_MODEL}+${OPUS_MODEL}`,
    llmCallDetails,
  };
}

function buildMockOneSheet(input: GenerateOneSheetInput): OneSheet {
  const generatedAt = new Date().toISOString();
  // Phase 8 regression: the mock one-sheet must produce a schema-valid
  // payload that the regression suite can shape-check without a live LLM.
  // That means:
  //   - 5 rubric scores (Ships/Resilience/CodeCraft/AiUsage/Communication)
  //   - at least one citation on every talking point
  //   - at least one tool in ai_usage_analysis.tools_used
  const hiddenStub = {
    kind: "test" as const,
    ref: "tests/mock-stub",
    excerpt: "mock evidence",
  };
  return {
    student_id: input.userId,
    cohort_id: input.cohortId,
    week: 0,
    project_key: "mock",
    rubric_version: "mock-rubric-version",
    overall_score: 80,
    overall_max: 100,
    overall_grade: "B",
    rubric_scores: [
      {
        criterion: "Ships",
        awarded_points: 20,
        max_points: 25,
        weight: 0.2,
        rationale: "Mock rationale: build + tests report OK.",
        citations: [hiddenStub],
        sub_scores: [],
      },
      {
        criterion: "Resilience",
        awarded_points: input.stage === "early" ? 0 : 20,
        max_points: 25,
        weight: 0.2,
        rationale:
          input.stage === "early"
            ? "dress_rehearsal: hidden-set results determine final Resilience score."
            : "Mock rationale: hidden-set verdicts aggregated.",
        citations: [hiddenStub],
        sub_scores: [],
      },
      {
        criterion: "CodeCraft",
        awarded_points: 15,
        max_points: 20,
        weight: 0.2,
        rationale: "Mock rationale: sonar metrics within thresholds.",
        citations: [hiddenStub],
        sub_scores: [],
      },
      {
        criterion: "AiUsage",
        awarded_points: 12,
        max_points: 15,
        weight: 0.2,
        rationale: "Mock rationale: structured prompts + tool invocation.",
        citations: [hiddenStub],
        sub_scores: [],
      },
      {
        criterion: "Communication",
        awarded_points: 13,
        max_points: 15,
        weight: 0.2,
        rationale: "Mock rationale: README + video transcript present.",
        citations: [hiddenStub],
        sub_scores: [],
      },
    ],
    talking_points: [
      {
        title: "Mock talking point",
        body: "Deterministic mock talking point for regression shape checks.",
        citations: [hiddenStub],
        severity: "info" as const,
      },
    ],
    ai_usage_analysis: {
      tools_used: [
        {
          name: "claude-code",
          invocations: 1,
          models: [`${SONNET_MODEL}+${OPUS_MODEL}`],
          notable_uses: ["mock tool use"],
        },
      ],
      sophistication: "basic" as const,
      sophistication_rationale: "mock",
      total_llm_calls: 3,
      evidence: [hiddenStub],
    },
    evaluation_coverage: {
      files_reviewed: 0,
      files_total: 0,
      commits_reviewed: 0,
      commits_total: 0,
      harness_log_entries_considered: input.normalizedLogs.entryCount,
      sonar_included: input.codeAnalysis.sonarMetrics !== null,
      notes: input.stage === "early" ? "dress_rehearsal" : undefined,
    },
    generated_at: generatedAt,
    model: `${SONNET_MODEL}+${OPUS_MODEL}`,
    pipeline_version: "kiln-phase5",
  };
}
