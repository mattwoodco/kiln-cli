import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckpointReport, LLMCallDetail } from "@kiln/shared";
import { eq } from "drizzle-orm";
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../db/schema.js";

/**
 * Persist a checkpoint report, its artifacts, and a pipeline_usage_events
 * row tagged `pipeline_type = "checkpoint"`.
 *
 * TTL rules:
 *  - Default retention = `cohort.config.checkpoint_retention_days` (fallback 7)
 *  - `persist: true` (propagated from the `--persist` CLI flag) → expires_at = null
 *  - Artifacts stored under `$STORAGE_PATH/cohorts/{cohortId}/checkpoints/{checkpointId}/`
 *    NOT under `/submissions/` — so cleanup can safely rm the whole directory.
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

export async function closeStoreCheckpointDb(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    cachedDb = null;
  }
}

function checkpointArtifactDir(cohortId: string, checkpointId: string): string {
  const base = process.env.STORAGE_PATH ?? "./data";
  return path.join(base, "cohorts", cohortId, "checkpoints", checkpointId);
}

async function storeCheckpointArtifact(
  cohortId: string,
  checkpointId: string,
  filename: string,
  content: string,
): Promise<string> {
  const dir = checkpointArtifactDir(cohortId, checkpointId);
  await mkdir(dir, { recursive: true });
  const fp = path.join(dir, filename);
  await writeFile(fp, content);
  return fp;
}

export interface StoreCheckpointInput {
  submissionId: string;
  cohortId: string;
  weekId: string;
  userId: string;
  report: CheckpointReport;
  sonarMetrics: Record<string, unknown> | null;
  llmCallDetails: LLMCallDetail[];
  durations: {
    gitCloneMs: number;
    dockerBuildMs: number;
    sonarqubeScanMs: number;
  };
  pipelineStartedAt: string;
  rubricVersion: string;
  promptVersion: string;
  modelVersion: string;
  persist: boolean;
  partialBuildLogs: string | null;
}

export interface StoreCheckpointResult {
  checkpointId: string;
  reportArtifactPath: string;
  usageEventId: string;
  expiresAt: string | null;
}

export async function storeCheckpoint(input: StoreCheckpointInput): Promise<StoreCheckpointResult> {
  const db = getDb();
  const completedAt = new Date();
  const pipelineStartedAt = new Date(input.pipelineStartedAt);
  const durationMs = completedAt.getTime() - pipelineStartedAt.getTime();

  // 1. Resolve TTL from cohort config (unless --persist).
  let retentionDays = 7;
  if (!input.persist) {
    const [cohort] = await db
      .select()
      .from(schema.cohorts)
      .where(eq(schema.cohorts.id, input.cohortId))
      .limit(1);
    const cfg = (cohort?.config ?? {}) as { checkpoint_retention_days?: unknown };
    if (typeof cfg.checkpoint_retention_days === "number" && cfg.checkpoint_retention_days > 0) {
      retentionDays = cfg.checkpoint_retention_days;
    }
  }

  const expiresAt = input.persist
    ? null
    : new Date(completedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);

  // 2. Insert checkpoints row.
  const [checkpointRow] = await db
    .insert(schema.checkpoints)
    .values({
      submissionId: input.submissionId,
      report: input.report as unknown as Record<string, unknown>,
      sonarMetrics: input.sonarMetrics,
      rubricVersion: input.rubricVersion,
      promptVersion: input.promptVersion,
      modelVersion: input.modelVersion,
      expiresAt,
    })
    .returning();
  if (!checkpointRow) {
    throw new Error("checkpoint_insert_failed");
  }

  // 3. Store artifacts.
  const reportPath = await storeCheckpointArtifact(
    input.cohortId,
    checkpointRow.id,
    "checkpoint-report.json",
    JSON.stringify(input.report, null, 2),
  );
  await storeCheckpointArtifact(
    input.cohortId,
    checkpointRow.id,
    "llm-calls.json",
    JSON.stringify(input.llmCallDetails, null, 2),
  );
  if (input.sonarMetrics) {
    await storeCheckpointArtifact(
      input.cohortId,
      checkpointRow.id,
      "sonar-metrics.json",
      JSON.stringify(input.sonarMetrics, null, 2),
    );
  }
  if (input.partialBuildLogs) {
    await storeCheckpointArtifact(
      input.cohortId,
      checkpointRow.id,
      "partial-build.log",
      input.partialBuildLogs,
    );
  }

  // 4. Update submissions.status so `GET /api/status/:jobId` reflects
  //    completion. Checkpoint submissions use type="checkpoint" and never
  //    appear in grading_results.
  await db
    .update(schema.submissions)
    .set({ status: "completed" })
    .where(eq(schema.submissions.id, input.submissionId));

  // 5. Emit pipeline_usage_events row with pipeline_type = "checkpoint".
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
      pipelineType: "checkpoint",
      startedAt: pipelineStartedAt,
      completedAt,
      status: "completed",
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
      artifactStorageBytes: Buffer.byteLength(JSON.stringify(input.report)),
      promptVersion: input.promptVersion,
      modelVersion: input.modelVersion,
      rubricVersion: input.rubricVersion,
    })
    .returning();
  if (!usageRow) {
    throw new Error("pipeline_usage_events_insert_failed");
  }

  return {
    checkpointId: checkpointRow.id,
    reportArtifactPath: reportPath,
    usageEventId: usageRow.id,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}
