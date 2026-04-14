import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../db/schema.js";
import type { StoreResultsInput, StoreResultsResult } from "./types.js";

/**
 * Persist grading results + artifacts + usage event.
 *
 * DEFERRED: dispatch child workflow kickoff lives here in the plan. Phase
 * 7.5 will land it. See the TODO below.
 */

type StoreDb = NodePgDatabase<typeof schema>;

let cachedPool: pg.Pool | null = null;
let cachedDb: StoreDb | null = null;

function getDb(): StoreDb {
  if (cachedDb) return cachedDb;
  const connectionString = process.env.DATABASE_URL ?? "postgres://kiln:kiln@localhost:5432/kiln";
  cachedPool = new pg.Pool({ connectionString, max: 4 });
  cachedDb = drizzle(cachedPool, { schema });
  return cachedDb;
}

export async function closeStoreDb(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    cachedDb = null;
  }
}

function artifactDir(cohortId: string, submissionId: string): string {
  const base = process.env.STORAGE_PATH ?? "./data";
  return path.join(base, "cohorts", cohortId, "submissions", submissionId);
}

async function storeFile(
  cohortId: string,
  submissionId: string,
  filename: string,
  content: string,
): Promise<string> {
  const dir = artifactDir(cohortId, submissionId);
  await mkdir(dir, { recursive: true });
  const fp = path.join(dir, filename);
  await writeFile(fp, content);
  return fp;
}

export async function storeResults(input: StoreResultsInput): Promise<StoreResultsResult> {
  const db = getDb();
  const completedAt = new Date();
  const pipelineStartedAt = new Date(input.pipelineStartedAt);
  const durationMs = completedAt.getTime() - pipelineStartedAt.getTime();

  // 1. Persist grading_results row.
  const [gradingRow] = await db
    .insert(schema.gradingResults)
    .values({
      submissionId: input.submissionId,
      oneSheet: input.oneSheet as unknown as Record<string, unknown>,
      sonarMetrics: (input.sonarMetrics as unknown as Record<string, unknown> | null) ?? null,
      overallScore: input.oneSheet.overall_score,
      overallGrade: input.oneSheet.overall_grade.slice(0, 2),
      rubricVersion: input.rubricVersion,
      promptVersion: input.promptVersion,
      modelVersion: input.modelVersion,
    })
    .returning();
  if (!gradingRow) {
    throw new Error("grading_results_insert_failed");
  }

  // 2. Store artifacts on the Fly volume / local filesystem.
  const oneSheetPath = await storeFile(
    input.cohortId,
    input.submissionId,
    "one-sheet.json",
    JSON.stringify(input.oneSheet, null, 2),
  );
  await storeFile(
    input.cohortId,
    input.submissionId,
    "llm-calls.json",
    JSON.stringify(input.llmCallDetails, null, 2),
  );
  if (input.sonarMetrics) {
    await storeFile(
      input.cohortId,
      input.submissionId,
      "sonar-metrics.json",
      JSON.stringify(input.sonarMetrics, null, 2),
    );
  }

  // 3. Update submissions.status.
  await db
    .update(schema.submissions)
    .set({ status: "graded" })
    .where(eq(schema.submissions.id, input.submissionId));

  // 4. Emit pipeline_usage_events row.
  const totals = input.llmCallDetails.reduce(
    (acc, call) => {
      acc.input += call.input_tokens;
      acc.output += call.output_tokens;
      acc.cacheRead += call.cache_read_tokens;
      acc.cacheWrite += call.cache_write_tokens;
      acc.cost += call.estimated_cost_usd;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );

  const [usageRow] = await db
    .insert(schema.pipelineUsageEvents)
    .values({
      cohortId: input.cohortId,
      weekId: input.weekId,
      userId: input.userId,
      submissionId: input.submissionId,
      pipelineType: "grading",
      startedAt: pipelineStartedAt,
      completedAt,
      status: "graded",
      durationMs,
      llmCalls: input.llmCallDetails as unknown as unknown[],
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalCacheReadTokens: totals.cacheRead,
      totalCacheWriteTokens: totals.cacheWrite,
      totalEstimatedCostUsd: totals.cost,
      sonarqubeScanDurationMs: input.durations.sonarqubeScanMs,
      dockerBuildDurationMs: input.durations.dockerBuildMs,
      gitCloneDurationMs: input.durations.gitCloneMs,
      artifactStorageBytes: Buffer.byteLength(JSON.stringify(input.oneSheet)),
      promptVersion: input.promptVersion,
      modelVersion: input.modelVersion,
      rubricVersion: input.rubricVersion,
    })
    .returning();
  if (!usageRow) {
    throw new Error("pipeline_usage_events_insert_failed");
  }

  // 5. Phase 7.5 — dispatch hook.
  // Child workflow kickoff happens in the WORKFLOW (grade-submission.ts),
  // not here, because activities cannot start child workflows directly.
  // store-results returns a `shouldDispatch` flag that the workflow consults.

  return {
    gradingResultId: gradingRow.id,
    oneSheetArtifactPath: oneSheetPath,
    usageEventId: usageRow.id,
    shouldDispatch: input.stage === "final",
  };
}
