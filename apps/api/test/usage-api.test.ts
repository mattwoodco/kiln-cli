import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildServer } from "../src/server.js";
import { closeDb } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

let app: FastifyInstance;
let harness: TestHarness;
const REF_DAY = new Date("2026-04-12T00:00:00Z");

async function seedEvent(opts: {
  cohortId: string;
  weekId: string;
  userId: string;
  startedAt: Date;
  costUsd?: number;
  type?: "grading" | "checkpoint";
  status?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  llmCalls?: unknown[];
}): Promise<void> {
  const [sub] = await harness.db
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
  if (!sub) throw new Error("seed");
  await harness.db.insert(schema.pipelineUsageEvents).values({
    cohortId: opts.cohortId,
    weekId: opts.weekId,
    userId: opts.userId,
    submissionId: sub.id,
    pipelineType: opts.type ?? "grading",
    startedAt: opts.startedAt,
    completedAt: new Date(opts.startedAt.getTime() + 30_000),
    status: opts.status ?? "graded",
    durationMs: 30_000,
    llmCalls: opts.llmCalls ?? [],
    totalInputTokens: opts.inputTokens ?? 1000,
    totalOutputTokens: 500,
    totalCacheReadTokens: opts.cacheReadTokens ?? 200,
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
  process.env.JWT_SECRET = "test-secret";
  harness = await setupHarness();
  app = await buildServer();
  await app.ready();
}, 30_000);

beforeEach(async () => {
  await harness.db.delete(schema.usageAlerts);
  await harness.db.delete(schema.usageDailyRollups);
  await harness.db.delete(schema.pipelineUsageEvents);
  await harness.db.delete(schema.submissions);
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await harness.close();
});

function tokenFor(userId: string, cohortId: string, role: "student" | "grader" | "admin"): string {
  return app.jwt.sign({ userId, cohortId, role });
}

describe("admin usage routes — auth gating", () => {
  it("returns 401 without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/usage/summary" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when caller is not an admin", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/usage/summary",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when caller is a grader (graders cannot see usage analytics)", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "grader");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/usage/summary",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/admin/usage/summary", () => {
  it("aggregates spend across cohorts and lists top cohorts", async () => {
    await seedEvent({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      costUsd: 1.0,
    });
    await seedEvent({
      cohortId: harness.cohortB.id,
      weekId: harness.weekB.id,
      userId: harness.studentB.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      costUsd: 0.25,
    });
    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/summary?from=2026-04-01&to=2026-04-30`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalSpend: number;
      runsByType: Record<string, number>;
      cacheHitRate: number;
      topCohorts: Array<{ cohortId: string; name: string; spend: number; runs: number }>;
    };
    expect(body.totalSpend).toBeCloseTo(1.25, 4);
    expect(body.runsByType.grading).toBe(2);
    expect(body.cacheHitRate).toBeGreaterThan(0);
    expect(body.topCohorts.length).toBe(2);
    expect(body.topCohorts[0]?.cohortId).toBe(harness.cohortA.id); // higher spend first
  });
});

describe("GET /api/admin/usage/cohorts/:id", () => {
  it("returns daily curve, per-week totals, and pipeline split", async () => {
    await seedEvent({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      costUsd: 0.50,
      type: "grading",
    });
    await seedEvent({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 90000_000),
      costUsd: 0.10,
      type: "checkpoint",
    });
    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/cohorts/${harness.cohortA.id}?from=2026-04-01&to=2026-04-30`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalSpend: number;
      dailySpendCurve: Array<{ date: string; cost: number }>;
      perWeekTotals: Array<{ weekNumber: number; cost: number }>;
      pipelineSplit: { grading: number; checkpoint: number };
    };
    expect(body.totalSpend).toBeCloseTo(0.6, 4);
    expect(body.pipelineSplit.grading).toBeCloseTo(0.5, 4);
    expect(body.pipelineSplit.checkpoint).toBeCloseTo(0.1, 4);
    expect(body.dailySpendCurve.length).toBeGreaterThanOrEqual(1);
    expect(body.perWeekTotals[0]?.weekNumber).toBe(1);
  });
});

describe("GET /api/admin/usage/cohorts/:id/students", () => {
  it("returns per-student rows sorted by cost desc", async () => {
    await seedEvent({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      costUsd: 0.10,
    });
    await seedEvent({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentB.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      costUsd: 1.50,
    });
    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/cohorts/${harness.cohortA.id}/students`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ userId: string; totalCost: number }>;
    expect(body.length).toBe(2);
    expect(body[0]?.userId).toBe(harness.studentB.id); // larger cost first
    expect(body[0]?.totalCost).toBeCloseTo(1.5, 4);
  });
});

describe("GET /api/admin/usage/cohorts/:id/weeks/:n", () => {
  it("returns pass-level cost breakdown + cache efficiency + failure rate", async () => {
    await seedEvent({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      inputTokens: 600,
      cacheReadTokens: 400,
      llmCalls: [
        { purpose: "analyze-code", estimated_cost_usd: 0.1, model: "claude-sonnet-4-6" },
        { purpose: "generate-one-sheet", estimated_cost_usd: 0.4, model: "claude-opus-4-6" },
      ],
    });
    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/cohorts/${harness.cohortA.id}/weeks/1`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      passBreakdown: Record<string, { calls: number; cost: number }>;
      cacheEfficiency: number;
      failureRate: number;
    };
    expect(body.passBreakdown.codeAnalysis?.calls).toBe(1);
    expect(body.passBreakdown.pass3?.calls).toBe(1);
    expect(body.passBreakdown.pass3?.cost).toBeCloseTo(0.4, 4);
    expect(body.cacheEfficiency).toBeCloseTo(0.4, 4);
    expect(body.failureRate).toBe(0);
  });

  it("returns 404 for unknown week", async () => {
    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/cohorts/${harness.cohortA.id}/weeks/99`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/admin/usage/alerts + acknowledge", () => {
  it("filters by severity + can be acknowledged", async () => {
    const [a] = await harness.db
      .insert(schema.usageAlerts)
      .values({
        cohortId: harness.cohortA.id,
        alertType: "test_alert",
        severity: "critical",
        title: "hello",
        detail: '{"date":"2026-04-12"}',
      })
      .returning();
    if (!a) throw new Error("seed alert");
    const tok = tokenFor(harness.admin.id, "", "admin");
    const list = await app.inject({
      method: "GET",
      url: `/api/admin/usage/alerts?severity=critical`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<{ id: string; severity: string }>;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(a.id);

    const ack = await app.inject({
      method: "POST",
      url: `/api/admin/usage/alerts/${a.id}/acknowledge`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(ack.statusCode).toBe(200);

    // Default list (acknowledged=false) should now be empty.
    const after = await app.inject({
      method: "GET",
      url: `/api/admin/usage/alerts`,
      headers: { authorization: `Bearer ${tok}` },
    });
    const remaining = after.json() as unknown[];
    expect(remaining.length).toBe(0);
  });
});

describe("super-admin bypass (MVP simplification)", () => {
  it("allows admin token with no cohortId to read cohort B even when their cohort claim is empty", async () => {
    await seedEvent({
      cohortId: harness.cohortB.id,
      weekId: harness.weekB.id,
      userId: harness.studentB.id,
      startedAt: new Date(REF_DAY.getTime() + 3600_000),
      costUsd: 1.0,
    });
    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/cohorts/${harness.cohortB.id}`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { totalSpend: number };
    expect(body.totalSpend).toBeCloseTo(1.0, 4);
  });
});
