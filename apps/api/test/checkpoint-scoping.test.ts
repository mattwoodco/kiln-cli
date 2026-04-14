import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { closeDb } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

/**
 * Cross-cohort isolation for checkpoints.
 *
 * A student in cohort A MUST NOT be able to read a checkpoint created for
 * a student in cohort B. The API returns 403 (cohort_scope_violation),
 * not 404, so the caller can distinguish "forbidden" from "missing".
 */

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

describe("checkpoint cohort scoping", () => {
  it("student A cannot read student B's cohort-B checkpoint", async () => {
    // Seed a checkpoint owned by student B in cohort B.
    const [sub] = await harness.db
      .insert(schema.submissions)
      .values({
        userId: harness.studentB.id,
        weekId: harness.weekB.id,
        repoUrl: "https://example.test/repo.git",
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        type: "checkpoint",
        stage: null,
        status: "completed",
      })
      .returning();
    if (!sub) throw new Error("sub insert");
    const [cp] = await harness.db
      .insert(schema.checkpoints)
      .values({
        submissionId: sub.id,
        report: { ok: true },
        sonarMetrics: null,
        rubricVersion: "rv",
        promptVersion: "pv",
        modelVersion: "claude-sonnet-4-6",
        expiresAt: new Date(Date.now() + 86400_000),
      })
      .returning();
    if (!cp) throw new Error("cp insert");

    const tokA = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: `/api/checkpoints/${cp.id}`,
      headers: { authorization: `Bearer ${tokA}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error?: string };
    expect(body.error).toBe("cohort_scope_violation");
  });

  it("graders in cohort B can read cohort-B checkpoints but not cohort-A", async () => {
    // Seed a checkpoint owned by student A in cohort A.
    const [sub] = await harness.db
      .insert(schema.submissions)
      .values({
        userId: harness.studentA.id,
        weekId: harness.weekA.id,
        repoUrl: "https://example.test/repo.git",
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        type: "checkpoint",
        stage: null,
        status: "completed",
      })
      .returning();
    if (!sub) throw new Error("sub insert");
    const [cp] = await harness.db
      .insert(schema.checkpoints)
      .values({
        submissionId: sub.id,
        report: { ok: true },
        sonarMetrics: null,
        rubricVersion: "rv",
        promptVersion: "pv",
        modelVersion: "claude-sonnet-4-6",
        expiresAt: new Date(Date.now() + 86400_000),
      })
      .returning();
    if (!cp) throw new Error("cp insert");

    const graderBTok = tokenFor(harness.studentB.id, harness.cohortB.id, "grader");
    const res = await app.inject({
      method: "GET",
      url: `/api/checkpoints/${cp.id}`,
      headers: { authorization: `Bearer ${graderBTok}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin can read any checkpoint across cohorts", async () => {
    // Seed in cohort A.
    const [sub] = await harness.db
      .insert(schema.submissions)
      .values({
        userId: harness.studentA.id,
        weekId: harness.weekA.id,
        repoUrl: "https://example.test/repo.git",
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        type: "checkpoint",
        stage: null,
        status: "completed",
      })
      .returning();
    if (!sub) throw new Error("sub insert");
    const [cp] = await harness.db
      .insert(schema.checkpoints)
      .values({
        submissionId: sub.id,
        report: { ok: true },
        sonarMetrics: null,
        rubricVersion: "rv",
        promptVersion: "pv",
        modelVersion: "claude-sonnet-4-6",
        expiresAt: new Date(Date.now() + 86400_000),
      })
      .returning();
    if (!cp) throw new Error("cp insert");

    const adminTok = tokenFor(harness.admin.id, "", "admin");
    const res = await app.inject({
      method: "GET",
      url: `/api/checkpoints/${cp.id}`,
      headers: { authorization: `Bearer ${adminTok}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
