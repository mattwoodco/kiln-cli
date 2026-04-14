/**
 * Live-LLM smoke test for the grading pipeline.
 *
 * Loads ONE gold-set submission and runs it through `generateOneSheet`
 * with real Anthropic API calls (no MOCK_LLM). Prints token counts,
 * latency, cost, and the first rubric score so a human can eyeball
 * sanity before promoting the live-LLM path out of DEFERRED.
 *
 * Run:
 *   source .env.local
 *   bun run apps/grading/scripts/live-smoke.ts [gs-be-mid|gs-be-top|...]
 */

import { generateOneSheet } from "../src/activities/generate-one-sheet.js";
import type {
  AnalyzeCodeResult,
  GenerateOneSheetInput,
  RunTestsResult,
} from "../src/activities/types.js";
import { loadGoldSet } from "../test/regression/gold-set/index.js";

if (process.env.MOCK_LLM === "1") {
  console.error("[live-smoke] MOCK_LLM=1 is set; unset it to run a real call.");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("[live-smoke] ANTHROPIC_API_KEY is not set; source .env.local first.");
  process.exit(1);
}

const target = process.argv[2] ?? "gs-be-mid";
const goldSet = await loadGoldSet();
const sub = goldSet.submissions.find((s) => s.id === target);
if (!sub) {
  console.error(`[live-smoke] gold-set submission '${target}' not found.`);
  console.error(`  available: ${goldSet.submissions.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

const testResults: RunTestsResult = {
  visible: [],
  hidden: sub.testResults.hiddenCount === null ? null : [],
  testSuitesPassed: sub.testResults.testSuitesPassed,
  testSuitesFailed: sub.testResults.testSuitesFailed,
};

const codeAnalysis: AnalyzeCodeResult = {
  sonarMetrics: null,
  sonarqubeScanDurationMs: 1,
  llmFeedback: `synthetic code analysis for ${sub.id}`,
  llmCallDetails: [],
};

const input: GenerateOneSheetInput = {
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

const t0 = performance.now();
console.error(`[live-smoke] running generateOneSheet on ${sub.id} (cohort=${sub.cohortName} week=${sub.weekNumber}) via real Anthropic API...`);
const result = await generateOneSheet(input);
const wall = Math.round(performance.now() - t0);

console.error(`[live-smoke] done in ${wall}ms`);
console.error(`[live-smoke] llm calls: ${result.llmCallDetails.length}`);
let totalIn = 0, totalOut = 0, totalCost = 0;
for (const c of result.llmCallDetails) {
  totalIn += c.input_tokens;
  totalOut += c.output_tokens;
  totalCost += c.estimated_cost_usd;
  console.error(`  - ${c.purpose.padEnd(24)} model=${c.model.padEnd(22)} in=${c.input_tokens} out=${c.output_tokens} latency=${c.latency_ms}ms cost=$${c.estimated_cost_usd.toFixed(6)}`);
}
console.error(`[live-smoke] totals: in=${totalIn} out=${totalOut} cost=$${totalCost.toFixed(6)}`);
console.error();
console.error(`[live-smoke] overall_grade: ${result.oneSheet.overall_grade} (${result.oneSheet.overall_score.toFixed(1)})`);
console.error(`[live-smoke] rubric scores:`);
for (const rs of result.oneSheet.rubric_scores) {
  console.error(`  - ${rs.criterion.padEnd(16)} ${String(rs.awarded_points).padStart(3)}/${rs.max_points}  ${rs.rationale.slice(0, 100)}`);
}
console.error(`[live-smoke] talking points: ${result.oneSheet.talking_points.length}`);
console.error(`[live-smoke] tools observed: ${result.oneSheet.ai_usage_analysis.tools_used.join(", ")}`);
