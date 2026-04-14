import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { closeDb } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

let app: FastifyInstance;
let harness: TestHarness;

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

async function seedRow(opts: {
  cohortId: string;
  weekId: string;
  userId: string;
  startedAt: Date;
  costUsd: number;
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
    pipelineType: "grading",
    startedAt: opts.startedAt,
    completedAt: new Date(opts.startedAt.getTime() + 30_000),
    status: "graded",
    durationMs: 30_000,
    llmCalls: [],
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCacheReadTokens: 200,
    totalCacheWriteTokens: 0,
    totalEstimatedCostUsd: opts.costUsd,
    sonarqubeScanDurationMs: 1000,
    dockerBuildDurationMs: 2000,
    gitCloneDurationMs: 500,
    artifactStorageBytes: 1024,
    promptVersion: "pv-1",
    modelVersion: "claude-sonnet-4-6",
    rubricVersion: "rv-1",
  });
}

describe("GET /api/admin/usage/export", () => {
  const EXPECTED_HEADER =
    "event_id,cohort_id,week_id,user_id,submission_id,pipeline_type,started_at,completed_at,status,duration_ms,total_input_tokens,total_output_tokens,total_cache_read_tokens,total_cache_write_tokens,total_estimated_cost_usd,sonarqube_scan_ms,docker_build_ms,prompt_version,model_version,rubric_version";

  it("emits CSV with header row + one data row per event", async () => {
    await seedRow({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date("2026-04-05T12:00:00Z"),
      costUsd: 0.42,
    });
    await seedRow({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date("2026-04-06T12:00:00Z"),
      costUsd: 0.10,
    });

    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/usage/export?from=2026-04-01&to=2026-04-30",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const body = res.payload;
    const lines = body.trim().split("\n");
    expect(lines[0]).toBe(EXPECTED_HEADER);
    expect(lines.length).toBe(3); // header + 2 rows
    // Verify cost cell formatting (6 decimals).
    expect(lines[1]).toContain("0.420000");
    expect(lines[2]).toContain("0.100000");
  });

  it("filters by date range — events outside [from,to] are excluded", async () => {
    await seedRow({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date("2026-03-15T12:00:00Z"),
      costUsd: 0.42,
    });
    await seedRow({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date("2026-04-15T12:00:00Z"),
      costUsd: 0.99,
    });

    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/usage/export?from=2026-04-01&to=2026-04-30",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.payload.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("0.990000");
    expect(lines[1]).not.toContain("0.420000");
  });

  it("filters by cohort_id when provided", async () => {
    await seedRow({
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      startedAt: new Date("2026-04-15T12:00:00Z"),
      costUsd: 0.42,
    });
    await seedRow({
      cohortId: harness.cohortB.id,
      weekId: harness.weekB.id,
      userId: harness.studentB.id,
      startedAt: new Date("2026-04-15T12:00:00Z"),
      costUsd: 0.99,
    });

    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/export?from=2026-04-01&to=2026-04-30&cohort_id=${harness.cohortB.id}`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.payload.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("0.990000");
  });

  it("rejects non-admin callers", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/usage/export",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
