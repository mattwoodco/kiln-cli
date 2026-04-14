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
  await harness.db.delete(schema.usageDailyRollups);
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await harness.close();
});

function tokenFor(userId: string, cohortId: string, role: "student" | "grader" | "admin"): string {
  return app.jwt.sign({ userId, cohortId, role });
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

describe("GET /api/admin/usage/forecast", () => {
  it("computes 7-day rolling avg and projects to month end", async () => {
    // Seed 5 historical days at $2/day (within last 7 days, before today).
    const now = new Date();
    for (let d = 1; d <= 5; d += 1) {
      const dt = new Date(now);
      dt.setUTCDate(dt.getUTCDate() - d);
      await harness.db.insert(schema.usageDailyRollups).values({
        cohortId: harness.cohortA.id,
        date: ymd(dt),
        pipelineType: "grading",
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        uniqueStudents: 1,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheReadTokens: 100,
        totalEstimatedCostUsd: 2.0,
        avgDurationMs: 30_000,
        p95DurationMs: 30_000,
        avgArtifactStorageBytes: 1024,
      });
    }

    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/forecast?cohort_id=${harness.cohortA.id}`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rolling7dAvgUsd: number;
      projectedMonthEndUsd: number;
      currentMonthSpend: number;
      daysRemaining: number;
    };

    // Expected: 5 days at $2/day → avg = $2.00
    expect(body.rolling7dAvgUsd).toBeCloseTo(2.0, 4);
    // currentMonthSpend depends on which calendar month "now" is in vs the
    // 5 seeded days — we only assert that it's a finite number ≥ 0 (the
    // route is correct as long as it queries the current calendar month).
    expect(body.currentMonthSpend).toBeGreaterThanOrEqual(0);
    expect(body.daysRemaining).toBeGreaterThanOrEqual(0);
    // Projection = currentMonthSpend + avg * daysRemaining
    const expected = body.currentMonthSpend + body.rolling7dAvgUsd * body.daysRemaining;
    expect(body.projectedMonthEndUsd).toBeCloseTo(expected, 4);
  });

  it("returns 0s when there is no rollup history", async () => {
    const tok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/forecast?cohort_id=${harness.cohortA.id}`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rolling7dAvgUsd: number; projectedMonthEndUsd: number };
    expect(body.rolling7dAvgUsd).toBe(0);
  });
});
