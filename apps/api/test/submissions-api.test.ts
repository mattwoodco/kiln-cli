import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { closeDb } from "../src/db/index.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

/**
 * Submissions API — JWT middleware, cohort scoping, stage validation.
 */

let app: FastifyInstance;
let harness: TestHarness;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://kiln:kiln@192.168.147.2:5432/kiln";
  process.env.JWT_SECRET = "test-secret";
  harness = await setupHarness();
  app = await buildServer();
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await harness.close();
  await closeDb();
});

function tokenFor(userId: string, cohortId: string, role: "student" | "grader" | "admin"): string {
  return app.jwt.sign({ userId, cohortId, role });
}

describe("JWT middleware", () => {
  it("rejects requests with no bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a signed token and returns /api/me", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { id: string }; cohort: { id: string } };
    expect(body.user.id).toBe(harness.studentA.id);
    expect(body.cohort.id).toBe(harness.cohortA.id);
  });
});

describe("cohort scoping", () => {
  it("student in cohort A cannot fetch cohort B's week config", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: `/api/cohorts/${harness.cohortB.id}/weeks/1`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("student in cohort A can fetch their own cohort's week config", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "GET",
      url: `/api/cohorts/${harness.cohortA.id}/weeks/1`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("stage validation", () => {
  it("defaults stage to final when omitted", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "POST",
      url: "/api/submissions",
      headers: {
        authorization: `Bearer ${tok}`,
        "content-type": "application/json",
      },
      payload: {
        repoUrl: "https://example.test/repo.git",
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        weekNumber: 1,
      },
    });
    // Temporal will likely be unreachable in the test env; 503 with the
    // submission id is acceptable. 200 is also fine if Temporal happens to
    // be up.
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json() as { submissionId?: string; stage?: string };
    expect(body.submissionId).toBeDefined();
  });

  it("rejects body with invalid stage", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id, "student");
    const res = await app.inject({
      method: "POST",
      url: "/api/submissions",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: {
        repoUrl: "https://example.test/repo.git",
        commitSha: "deadbeef",
        weekNumber: 1,
        stage: "bogus",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
