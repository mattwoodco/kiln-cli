import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { closeDb } from "../src/db/index.js";
import {
  HIDDEN_CANARY,
  TEST_HIDDEN_CHAOS_YAML,
  setupHarness,
  type TestHarness,
} from "./fixtures.js";

/**
 * Integration test: the server must NEVER leak hidden_chaos_yaml through any
 * student-scoped route. We grep the full response bodies for the canary byte
 * present only in the hidden YAML.
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

function tokenFor(userId: string, cohortId: string): string {
  return app.jwt.sign({ userId, cohortId, role: "student" });
}

describe("hidden chaos isolation", () => {
  it("GET /api/me never contains hidden canary", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id);
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(HIDDEN_CANARY);
    expect(res.body).not.toContain("hidden");
  });

  it("GET /api/cohorts/:id/weeks/:n never contains hidden canary", async () => {
    const tok = tokenFor(harness.studentA.id, harness.cohortA.id);
    const res = await app.inject({
      method: "GET",
      url: `/api/cohorts/${harness.cohortA.id}/weeks/1`,
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    // The week should include the visible YAML but never the hidden YAML.
    expect(res.body).toContain("profile: visible");
    expect(res.body).not.toContain("profile: hidden");
    // Sanity: TEST_HIDDEN_CHAOS_YAML contents should not appear in any form.
    for (const line of TEST_HIDDEN_CHAOS_YAML.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("profile: hidden") || trimmed.startsWith("parameters: { ms: 900 }")) {
        expect(res.body).not.toContain(trimmed);
      }
    }
  });
});
