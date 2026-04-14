import Anthropic from "@anthropic-ai/sdk";
import {
  type CheckpointEvaluationCoverage,
  type CheckpointReport,
  CheckpointReportSchema,
  type LLMCallDetail,
} from "@kiln/shared";
import { compositePromptVersion, hashRubricYaml, loadPrompt } from "../lib/prompt-versioning.js";
import { trackedLLMCall } from "../lib/tracked-llm-call.js";
import type { AnalyzeCodeLightResult } from "./analyze-code-light.js";
import type { BuildDockerResult, NormalizedLogs, RunTestsResult } from "./types.js";

/**
 * Single-pass checkpoint report generator (Sonnet only).
 *
 * Design goals:
 *   - ONE LLM call, not three. Cost control is the whole point of checkpoints.
 *   - Prompt caching key = `cohortId + weekId` so a subsequent full grading
 *     run for the same week hits the same cached prefix.
 *   - Explicitly admits missing evidence via `evaluation_coverage`: when
 *     something couldn't be assessed, `indicative_score` is `null` and the
 *     status is `not-started` or `blocked`.
 *   - MOCK_LLM=1 path returns a deterministic report that passes
 *     `CheckpointReportSchema.parse`. The checkpoint-submission workflow
 *     test and the unit test both rely on this.
 */

const SONNET_MODEL = "claude-sonnet-4-6";
const PIPELINE_VERSION = "kiln-phase6-checkpoint";

export interface GenerateCheckpointReportInput {
  submissionId: string;
  userId: string;
  cohortId: string;
  weekId: string;
  weekNumber: number;
  projectKey: string;
  rubricYaml: string;
  normalizedLogs: NormalizedLogs;
  codeAnalysis: AnalyzeCodeLightResult;
  testResults: RunTestsResult | null;
  buildResult: BuildDockerResult | null;
}

export interface GenerateCheckpointReportResult {
  report: CheckpointReport;
  rubricVersion: string;
  promptVersion: string;
  modelVersion: string;
  llmCallDetails: LLMCallDetail[];
}

export async function generateCheckpointReport(
  input: GenerateCheckpointReportInput,
): Promise<GenerateCheckpointReportResult> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY ?? "mock-key-for-test-env",
  });

  // Cache key shared with the full grading pipeline (`cached-prefix.txt`).
  // Both pipelines resolve `{{rubric}}` against the same rubric YAML so a
  // checkpoint run that happens before full grading primes the cache for
  // the subsequent grading call on the same `(cohortId, weekId)`.
  const cachedPrefix = (await loadPrompt("checkpoint-cached-prefix.txt")).replace(
    "{{rubric}}",
    input.rubricYaml,
  );
  const checkpointInstructions = await loadPrompt("checkpoint-analysis.txt");

  const coverage = computeCoverage(input);

  const evidence = {
    submissionId: input.submissionId,
    cohortId: input.cohortId,
    weekId: input.weekId,
    buildStatus: input.buildResult?.status ?? "skipped",
    testsStatus: testsStatus(input.testResults),
    visibleVerdicts: input.testResults?.visible.map((r) => r.verdict) ?? null,
    harnessEntries: input.normalizedLogs.entryCount,
    harnessGaps: input.normalizedLogs.gaps,
    sonarMetrics: input.codeAnalysis.sonarMetrics,
    codeAnalysisNotes: input.codeAnalysis.llmFeedback,
    evaluationCoverage: coverage,
  };

  const cacheKey = `${input.cohortId}::${input.weekId}`;
  const mockReport = buildMockReport(input, coverage);

  const call = await trackedLLMCall<CheckpointReport>(
    client,
    {
      model: SONNET_MODEL,
      max_tokens: 4096,
      metadata: { user_id: cacheKey },
      system: [
        { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: checkpointInstructions },
      ],
      messages: [
        {
          role: "user",
          content: [
            `Produce a checkpoint report for submission ${input.submissionId}`,
            `(cohort ${input.cohortId}, week ${input.weekNumber}).`,
            "Remember: this is a FORMATIVE checkpoint. When evidence is missing,",
            'set indicative_score to null and status to "not-started" or "blocked".',
            "Be honest about what you could not assess.",
            `Evidence:\n${JSON.stringify(evidence)}`,
          ].join(" "),
        },
      ],
    },
    {
      purpose: "checkpoint-analysis",
      mockPayload: mockReport,
      mockText: JSON.stringify(mockReport),
    },
  );

  // Validate the model output. Fall back to the mock shape on parse failure
  // so the pipeline can still store a valid artifact for triage. Real-call
  // failures are rare in checkpoint paths because MOCK_LLM=1 is the default
  // in tests.
  let report: CheckpointReport;
  if (call.parsed) {
    report = CheckpointReportSchema.parse(call.parsed);
  } else {
    try {
      report = CheckpointReportSchema.parse(JSON.parse(call.text));
    } catch {
      report = CheckpointReportSchema.parse(mockReport);
    }
  }

  const promptVersion = await compositePromptVersion([
    "checkpoint-cached-prefix.txt",
    "checkpoint-analysis.txt",
  ]);

  return {
    report,
    rubricVersion: hashRubricYaml(input.rubricYaml),
    promptVersion,
    modelVersion: SONNET_MODEL,
    llmCallDetails: [call.detail],
  };
}

function testsStatus(tests: RunTestsResult | null): "ok" | "failed" | "skipped" {
  if (tests === null) return "skipped";
  if (tests.testSuitesFailed > 0) return "failed";
  return "ok";
}

function computeCoverage(input: GenerateCheckpointReportInput): CheckpointEvaluationCoverage {
  const build = input.buildResult;
  const dockerBuild: CheckpointEvaluationCoverage["docker_build"] = !build
    ? "skipped"
    : build.status === "ok"
      ? "ok"
      : build.status === "missing"
        ? "missing"
        : "failed";
  const testsRun: CheckpointEvaluationCoverage["tests_run"] =
    input.testResults === null
      ? "skipped"
      : input.testResults.testSuitesFailed > 0
        ? "failed"
        : "ok";

  return {
    docker_build: dockerBuild,
    tests_run: testsRun,
    harness_logs_present: input.normalizedLogs.entryCount > 0,
    sonar_included: input.codeAnalysis.sonarMetrics !== null,
    files_considered: input.codeAnalysis.sonarMetrics?.lines_of_code ?? 0,
    notes: input.normalizedLogs.gaps.length > 0 ? input.normalizedLogs.gaps.join("; ") : undefined,
  };
}

function buildMockReport(
  input: GenerateCheckpointReportInput,
  coverage: CheckpointEvaluationCoverage,
): CheckpointReport {
  // Deterministic synthetic report used by MOCK_LLM=1 and by the fall-back
  // on parse failure. We intentionally emit at least one `null`
  // indicative_score so callers see the "evidence missing" path exercised.
  const shipsStatus = coverage.docker_build === "ok" ? "on-track" : "at-risk";
  const hasTestEvidence = coverage.tests_run === "ok";
  const rubricHash = hashRubricYaml(input.rubricYaml).slice(0, 8);

  return {
    student_id: input.userId,
    cohort_id: input.cohortId,
    week: input.weekNumber,
    project_key: input.projectKey,
    checkpoint_kind: "mid-week",
    generated_at: new Date().toISOString(),
    overall_status: shipsStatus === "on-track" && hasTestEvidence ? "on-track" : "at-risk",
    overall_summary: `Mock checkpoint report (rubric=${rubricHash}). Build: ${coverage.docker_build}, Tests: ${coverage.tests_run}.`,
    gaps: [
      {
        criterion: "Ships",
        status: shipsStatus,
        indicative_score: shipsStatus === "on-track" ? 18 : null,
        max_points: 25,
        recommendations:
          shipsStatus === "on-track"
            ? ["Keep the compose stack green."]
            : ["Add a working Dockerfile and compose setup so the pipeline can build."],
        evidence: [],
        summary:
          shipsStatus === "on-track"
            ? "Docker build succeeded."
            : "Docker build did not produce a runnable image.",
      },
      {
        criterion: "Resilience",
        status: hasTestEvidence ? "on-track" : "not-started",
        // Explicit null when evidence missing — exercises the nullable path.
        indicative_score: hasTestEvidence ? 15 : null,
        max_points: 25,
        recommendations: hasTestEvidence
          ? ["Expand breaker coverage to the p99 tail."]
          : ["Run at least one visible chaos experiment to establish a baseline."],
        evidence: [],
        summary: hasTestEvidence
          ? "Visible chaos experiments passed steady-state checks."
          : "No test evidence available for this checkpoint.",
      },
      {
        criterion: "AI Usage",
        status: input.normalizedLogs.entryCount > 0 ? "on-track" : "not-started",
        indicative_score: null,
        max_points: 20,
        recommendations: [
          input.normalizedLogs.entryCount > 0
            ? "Annotate harness logs with the intent behind each tool call."
            : "Submit harness logs so your AI usage can be assessed.",
        ],
        evidence: [],
        summary:
          input.normalizedLogs.entryCount > 0
            ? `Observed ${input.normalizedLogs.entryCount} harness log entries.`
            : "No harness logs present — unable to assess AI usage yet.",
      },
    ],
    evaluation_coverage: coverage,
    ai_usage_snapshot: {
      total_llm_calls: input.normalizedLogs.toolUses,
      distinct_tools: Object.keys(input.normalizedLogs.byKind),
      sophistication: input.normalizedLogs.entryCount > 0 ? "basic" : null,
      notes:
        input.normalizedLogs.entryCount > 0
          ? undefined
          : "No harness logs submitted — sophistication not measurable.",
    },
    top_priorities: [
      {
        title: "Land the build",
        detail: "Without a working Docker build the grader cannot verify Ships.",
        criterion: "Ships",
      },
      {
        title: "Exercise chaos experiments",
        detail: "Run at least the visible experiments to prove resilience.",
        criterion: "Resilience",
      },
      {
        title: "Commit harness logs",
        detail: "Your AI usage can only be evaluated from the harness log trail.",
        criterion: "AI Usage",
      },
    ],
    commits_considered: 0,
    harness_entries_considered: input.normalizedLogs.entryCount,
    model: SONNET_MODEL,
    pipeline_version: PIPELINE_VERSION,
  };
}
