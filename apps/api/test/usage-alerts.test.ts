import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { runDailyRollup } from "../src/jobs/rollup-usage.js";
import { closeDb } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

/**
 * Each anomaly rule fires correctly + dedup works.
 *
 * Plan ref: Phase 7 §1 alert table (lines 1076-1082).
 */

let harness: TestHarness;
const REF_DAY = new Date("2026-04-11T00:00:00Z");

async function insertEvent(
  h: TestHarness,
  opts: {
    cohortId: string;
    weekId: string;
    userId: string;
    type?: "grading" | "checkpoint";
    status?: string;
    startedAt: Date;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
    llmCalls?: unknown[];
  },
): Promise<void> {
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
  if (!sub) throw new Error("seed sub");
  await h.db.insert(schema.pipelineUsageEvents).values({
    cohortId: opts.cohortId,
    weekId: opts.weekId,
    userId: opts.userId,
    submissionId: sub.id,
    pipelineType: opts.type ?? "grading",
    startedAt: opts.startedAt,
    completedAt: new Date(opts.startedAt.getTime() + (opts.durationMs ?? 30_000)),
    status: opts.status ?? "graded",
    durationMs: opts.durationMs ?? 30_000,
    llmCalls: opts.llmCalls ?? [],
    totalInputTokens: opts.inputTokens ?? 1000,
    totalOutputTokens: opts.outputTokens ?? 500,
    totalCacheReadTokens: opts.cacheReadTokens ?? 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCostUsd: opts.costUsd ?? 0.5,
    sonarqubeScanDurationMs: 1000,
    dockerBuildDurationMs: 2000,
    gitCloneDurationMs: 500,
    artifactStorageBytes: 1024,
    promptVersion: "pv-1",
    modelVersion: "claude-sonnet-4-6",
    rubricVersion: "rv-1",
  });
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

describe("alert rules", () => {
  it("fires student_cost_outlier when one student spends >3× cohort avg", async () => {
    // Three normal students at $0.10, one whale at $1.00.
    // avg = (0.10*3 + 1.00) / 4 = 0.325, whale > 3 * 0.325 = 0.975 ✓
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      costUsd: 1.0,
    });
    for (let i = 0; i < 3; i += 1) {
      await insertEvent(harness, {
        cohortId: harness.cohortA.id,
        weekId: harness.weekA.id,
        userId: harness.studentB.id,
        startedAt: new Date(REF_DAY.getTime() + (i + 2) * 3600_000),
        costUsd: 0.10,
      });
    }
    // studentB spends 0.30, studentA spends 1.0. avg per row = (1+0.1*3)/4=0.325
    // Wait: avg_cost is computed per event, not per student. So avg=0.325.
    // perStudent A=1.0 > 3*0.325 = 0.975 ✓, perStudent B=0.30 not.

    const stats = await runDailyRollup(REF_DAY);
    expect(stats.alertsInserted).toBeGreaterThanOrEqual(1);

    const alerts = await harness.db
      .select()
      .from(schema.usageAlerts)
      .where(eq(schema.usageAlerts.alertType, "student_cost_outlier"));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const a = alerts[0];
    if (!a) throw new Error("missing alert");
    expect(a.severity).toBe("info");
    const detail = JSON.parse(a.detail) as { userId: string };
    expect(detail.userId).toBe(harness.studentA.id);

    // Dedup: re-run, no new alert row.
    await runDailyRollup(REF_DAY);
    const after = await harness.db
      .select()
      .from(schema.usageAlerts)
      .where(eq(schema.usageAlerts.alertType, "student_cost_outlier"));
    expect(after.length).toBe(alerts.length);
  });

  it("fires cache_hit_rate_low when ratio drops below 40%", async () => {
    // input=900, cache_read=100 → 100/(900+100)=0.10 < 0.4
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      inputTokens: 900,
      cacheReadTokens: 100,
    });
    await runDailyRollup(REF_DAY);
    const alerts = await harness.db
      .select()
      .from(schema.usageAlerts)
      .where(eq(schema.usageAlerts.alertType, "cache_hit_rate_low"));
    expect(alerts.length).toBe(1);
    const a = alerts[0];
    if (!a) throw new Error("missing");
    expect(a.severity).toBe("warning");
  });

  it("fires failure_rate_high when >10% of runs fail", async () => {
    // 10 successes + 2 failures = 16.6% failure rate ✓
    for (let i = 0; i < 10; i += 1) {
      await insertEvent(harness, {
        cohortId: harness.cohortA.id,
        weekId: harness.weekA.id,
        userId: harness.studentA.id,
        startedAt: new Date(REF_DAY.getTime() + (i + 1) * 60_000),
        status: "graded",
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await insertEvent(harness, {
        cohortId: harness.cohortA.id,
        weekId: harness.weekA.id,
        userId: harness.studentA.id,
        startedAt: new Date(REF_DAY.getTime() + (i + 11) * 60_000),
        status: "failed",
      });
    }
    await runDailyRollup(REF_DAY);
    const alerts = await harness.db
      .select()
      .from(schema.usageAlerts)
      .where(eq(schema.usageAlerts.alertType, "failure_rate_high"));
    expect(alerts.length).toBe(1);
    const a = alerts[0];
    if (!a) throw new Error("missing");
    expect(a.severity).toBe("critical");
  });

  it("fires spend_spike when today >2× 7-day rolling avg", async () => {
    // Seed 3 prior days at $1/day directly into rollups.
    for (let d = 1; d <= 3; d += 1) {
      const dt = new Date(REF_DAY.getTime() - d * 86400_000);
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
      await harness.db.insert(schema.usageDailyRollups).values({
        cohortId: harness.cohortA.id,
        date: key,
        pipelineType: "grading",
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        uniqueStudents: 1,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheReadTokens: 0,
        totalEstimatedCostUsd: 1.0,
        avgDurationMs: 30_000,
        p95DurationMs: 30_000,
        avgArtifactStorageBytes: 1024,
      });
    }
    // Today: $5 spent (much more than 2×$1 avg).
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      costUsd: 5.0,
    });
    await runDailyRollup(REF_DAY);
    const alerts = await harness.db
      .select()
      .from(schema.usageAlerts)
      .where(eq(schema.usageAlerts.alertType, "spend_spike"));
    expect(alerts.length).toBe(1);
    const a = alerts[0];
    if (!a) throw new Error("missing");
    expect(a.severity).toBe("warning");
  });

  it("fires opus_leak_non_synthesis when Opus is used outside generate-one-sheet", async () => {
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      llmCalls: [
        {
          model: "claude-opus-4-6",
          purpose: "analyze-code",
          input_tokens: 1000,
          output_tokens: 500,
        },
        {
          model: "claude-opus-4-6",
          purpose: "generate-one-sheet", // legitimate, should not trigger
          input_tokens: 800,
          output_tokens: 400,
        },
      ],
    });
    await runDailyRollup(REF_DAY);
    const alerts = await harness.db
      .select()
      .from(schema.usageAlerts)
      .where(eq(schema.usageAlerts.alertType, "opus_leak_non_synthesis"));
    expect(alerts.length).toBe(1);
    const a = alerts[0];
    if (!a) throw new Error("missing");
    expect(a.severity).toBe("critical");
    const detail = JSON.parse(a.detail) as { opusCallCount: number };
    expect(detail.opusCallCount).toBe(1); // only one offending call
  });

  it("does not deduplicate the same alert type across different days", async () => {
    // Day 1 — trigger cache_hit_rate_low
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      inputTokens: 900,
      cacheReadTokens: 100,
    });
    await runDailyRollup(REF_DAY);

    // Day 2 — trigger again, should produce a SECOND alert because date differs.
    const day2 = new Date(REF_DAY.getTime() + 86400_000);
    await insertEvent(harness, {
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(day2.getTime() + 3600_000),
      inputTokens: 900,
      cacheReadTokens: 100,
    });
    await runDailyRollup(day2);

    const alerts = await harness.db
      .select()
      .from(schema.usageAlerts)
      .where(eq(schema.usageAlerts.alertType, "cache_hit_rate_low"));
    expect(alerts.length).toBe(2);
  });
});
