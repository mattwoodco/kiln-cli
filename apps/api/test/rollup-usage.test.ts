import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { runDailyRollup } from "../src/jobs/rollup-usage.js";
import { closeDb } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

/**
 * Rollup math correctness + idempotency.
 *
 * Plan ref: Phase 7 §1.
 */

let harness: TestHarness;
const REF_DAY = new Date("2026-04-10T00:00:00Z");

async function insertEvent(
  h: TestHarness,
  opts: {
    cohortId: string;
    weekId: string;
    userId: string;
    type?: "grading" | "checkpoint";
    status?: string;
    startedAt: Date;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
    artifactBytes?: number;
    llmCalls?: unknown[];
  },
): Promise<string> {
  // Need a submission row first.
  const [sub] = await h.db
    .insert(schema.submissions)
    .values({
      userId: opts.userId,
      weekId: opts.weekId,
      repoUrl: "https://example.test/repo.git",
      commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      type: "final",
      stage: "final",
      status: "graded",
    })
    .returning();
  if (!sub) throw new Error("seed submission");
  const [row] = await h.db
    .insert(schema.pipelineUsageEvents)
    .values({
      cohortId: opts.cohortId,
      weekId: opts.weekId,
      userId: opts.userId,
      submissionId: sub.id,
      pipelineType: opts.type ?? "grading",
      startedAt: opts.startedAt,
      completedAt: new Date(opts.startedAt.getTime() + opts.durationMs),
      status: opts.status ?? "graded",
      durationMs: opts.durationMs,
      llmCalls: opts.llmCalls ?? [],
      totalInputTokens: opts.inputTokens ?? 1000,
      totalOutputTokens: opts.outputTokens ?? 500,
      totalCacheReadTokens: opts.cacheReadTokens ?? 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCostUsd: opts.costUsd ?? 0.5,
      sonarqubeScanDurationMs: 1000,
      dockerBuildDurationMs: 2000,
      gitCloneDurationMs: 500,
      artifactStorageBytes: opts.artifactBytes ?? 1024,
      promptVersion: "pv-1",
      modelVersion: "claude-sonnet-4-6",
      rubricVersion: "rv-1",
    })
    .returning();
  if (!row) throw new Error("seed event");
  return row.id;
}

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://kiln:kiln@192.168.147.2:5432/kiln";
  harness = await setupHarness();
}, 30_000);

beforeEach(async () => {
  await harness.db.delete(schema.usageAlerts);
  await harness.db.delete(schema.usageDailyRollups);
  await harness.db.delete(schema.pipelineUsageEvents);
  await harness.db.delete(schema.submissions);
});

afterAll(async () => {
  await closeDb();
  await harness.close();
});

describe("runDailyRollup — math + idempotency", () => {
  it("aggregates events into a single rollup row per (cohort,date,type)", async () => {
    // Three grading runs for cohort A, two students.
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3 * 3600_000),
      durationMs: 60_000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      costUsd: 0.25,
      artifactBytes: 1024,
    });
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 5 * 3600_000),
      durationMs: 90_000,
      inputTokens: 2000,
      outputTokens: 1000,
      cacheReadTokens: 800,
      costUsd: 0.55,
      artifactBytes: 2048,
    });
    // Different student — should bump unique_students to 2.
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentB.id,
      startedAt: new Date(REF_DAY.getTime() + 8 * 3600_000),
      durationMs: 30_000,
      inputTokens: 500,
      outputTokens: 250,
      cacheReadTokens: 500,
      costUsd: 0.10,
      artifactBytes: 512,
    });

    const stats = await runDailyRollup(REF_DAY);
    expect(stats.rollupRowsWritten).toBe(1);

    const rollups = await harness.db
      .select()
      .from(schema.usageDailyRollups)
      .where(eq(schema.usageDailyRollups.cohortId, harness.cohortA.id));
    expect(rollups.length).toBe(1);
    const r = rollups[0];
    if (!r) throw new Error("missing rollup");
    expect(r.totalRuns).toBe(3);
    expect(r.successfulRuns).toBe(3);
    expect(r.failedRuns).toBe(0);
    expect(r.uniqueStudents).toBe(2);
    expect(r.totalInputTokens).toBe(3500);
    expect(r.totalOutputTokens).toBe(1750);
    expect(r.totalCacheReadTokens).toBe(1500);
    expect(r.totalEstimatedCostUsd).toBeCloseTo(0.9, 4);
    // avg duration = (60+90+30)*1000/3 = 60000
    expect(r.avgDurationMs).toBe(60_000);
    // p95 of [30000,60000,90000] interpolated: rank=0.95*2=1.9 → 60000 + (90000-60000)*0.9 = 87000
    expect(r.p95DurationMs).toBe(87_000);
    // avg artifact = (1024+2048+512)/3 = 1194.67 → 1195
    expect(r.avgArtifactStorageBytes).toBe(1195);
  });

  it("counts failed runs separately and is idempotent on repeat invocation", async () => {
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 1 * 3600_000),
      durationMs: 10_000,
      status: "graded",
    });
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 2 * 3600_000),
      durationMs: 10_000,
      status: "failed",
      costUsd: 0,
    });

    await runDailyRollup(REF_DAY);
    await runDailyRollup(REF_DAY); // second invocation — must NOT duplicate

    const rollups = await harness.db
      .select()
      .from(schema.usageDailyRollups)
      .where(eq(schema.usageDailyRollups.cohortId, harness.cohortA.id));
    expect(rollups.length).toBe(1);
    const r = rollups[0];
    if (!r) throw new Error("missing rollup");
    expect(r.totalRuns).toBe(2);
    expect(r.successfulRuns).toBe(1);
    expect(r.failedRuns).toBe(1);
  });

  it("emits separate rollup rows per pipeline_type", async () => {
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      type: "grading",
      startedAt: new Date(REF_DAY.getTime() + 1 * 3600_000),
      durationMs: 60_000,
      status: "graded",
    });
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      type: "checkpoint",
      startedAt: new Date(REF_DAY.getTime() + 2 * 3600_000),
      durationMs: 30_000,
      status: "completed",
    });

    await runDailyRollup(REF_DAY);

    const rollups = await harness.db
      .select()
      .from(schema.usageDailyRollups)
      .where(eq(schema.usageDailyRollups.cohortId, harness.cohortA.id));
    expect(rollups.length).toBe(2);
    const types = rollups.map((r) => r.pipelineType).sort();
    expect(types).toEqual(["checkpoint", "grading"]);
    for (const r of rollups) expect(r.successfulRuns).toBe(1);
  });

  it("returns zero stats when there are no events for the day", async () => {
    const stats = await runDailyRollup(REF_DAY);
    expect(stats.rollupRowsWritten).toBe(0);
    expect(stats.alertsInserted).toBe(0);
  });
});
