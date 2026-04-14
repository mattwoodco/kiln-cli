import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
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
  await harness.db.delete(schema.checkpoints);
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await harness.close();
});

function tokenFor(userId: string, cohortId: string, role: "student" | "grader" | "admin"): string {
  return app.jwt.sign({ userId, cohortId, role });
}

async function seedCheckpoint(
  userId: string,
  weekId: string,
  createdAt?: Date,
): Promise<{ submissionId: string; checkpointId: string }> {
  const [sub] = await harness.db
    .insert(schema.submissions)
    .values({
      userId,
      weekId,
      repoUrl: "https://example.test/repo.git",
      commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      type: "checkpoint",
      stage: null,
      status: "completed",
    })
    .returning();
  if (!sub) throw new Error("seed submission");
  const [cp] = await harness.db
    .insert(schema.checkpoints)
    .values({
      submissionId: sub.id,
      report: { overall_summary: `seeded @${createdAt?.toISOString() ?? "now"}`, mock: true },
      sonarMetrics: null,
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "claude-sonnet-4-6",
      expiresAt: new Date(Date.now() + 86400_000),
      ...(createdAt ? { createdAt } : {}),
    })
    .returning();
  if (!cp) throw new Error("seed checkpoint");
  return { submissionId: sub.id, checkpointId: cp.id };
}

describe("POST /api/checkpoints", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkpoints",
      payload: {
        repoUrl: "https://example.test/repo.git",
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        weekNumber: 1,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a checkpoint for an authenticated student", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "POST",
      url: "/api/checkpoints",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: {
        repoUrl: "https://example.test/repo.git",
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        weekNumber: 1,
      },
    });
    // Temporal may be unreachable in the test env; 503 with a checkpointId
    // is acceptable. 200 is also fine.
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json() as { checkpointId?: string };
    expect(body.checkpointId).toBeDefined();
  });

  it("returns 403 when cohort has checkpoints_enabled=false", async () => {
    await harness.db
      .update(schema.cohorts)
      .set({ config: { checkpoints_enabled: false, checkpoint_retention_days: 7 } })
      .where(eq(schema.cohorts.id, harness.cohortA.id));

    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "POST",
      url: "/api/checkpoints",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: {
        repoUrl: "https://example.test/repo.git",
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        weekNumber: 1,
      },
    });
    expect(res.statusCode).toBe(403);

    // restore
    await harness.db
      .update(schema.cohorts)
      .set({ config: { checkpoints_enabled: true, checkpoint_retention_days: 7 } })
      .where(eq(schema.cohorts.id, harness.cohortA.id));
  });
});

describe("GET /api/checkpoints/:id", () => {
  it("returns the checkpoint for its owner", async () => {
    const { checkpointId } = await seedCheckpoint(harness.studentA.id, harness.weekA.id);
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: `/api/checkpoints/${checkpointId}`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; report: Record<string, unknown> };
    expect(body.id).toBe(checkpointId);
    expect(body.report).toBeDefined();
  });

  it("returns 404 for a missing id", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: "/api/checkpoints/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/checkpoints/history", () => {
  it("returns the caller's checkpoints ordered newest-first", async () => {
    // Seed three checkpoints: two for studentA at week 1, one for studentB.
    const older = await seedCheckpoint(
      harness.studentA.id,
      harness.weekA.id,
      new Date(Date.now() - 2 * 86400_000),
    );
    const newer = await seedCheckpoint(
      harness.studentA.id,
      harness.weekA.id,
      new Date(Date.now() - 1 * 86400_000),
    );
    await seedCheckpoint(harness.studentB.id, harness.weekB.id);

    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: "/api/checkpoints/history?weekNumber=1",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; createdAt: string }>;
    expect(body.length).toBe(2);
    // Ordered desc by createdAt → newer first.
    expect(body[0]?.id).toBe(newer.checkpointId);
    expect(body[1]?.id).toBe(older.checkpointId);
  });

  it("is cohort-scoped — cohortB student cannot see cohortA checkpoints", async () => {
    await seedCheckpoint(harness.studentA.id, harness.weekA.id);
    const tok = tokenFor(harness.studentB.id, harness.cohortB.id, "student");
    const res = await app.inject({
      method: "GET",
      url: "/api/checkpoints/history?weekNumber=1",
      headers: { authorization: `Bearer ${tok}` },
    });
    // Uses cohort B's week; should return empty (not leak A's).
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<unknown>;
    expect(body).toEqual([]);
  });
});
