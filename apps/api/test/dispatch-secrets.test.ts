import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { buildServer } from "../src/server.js";
import { type TestHarness, setupHarness } from "./fixtures.js";

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
  await harness.db.delete(schema.dispatchEvents);
  await harness.db.delete(schema.dispatchTargets);
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await harness.close();
});

function adminToken(cohortId: string): string {
  return app.jwt.sign({ userId: harness.admin.id, cohortId, role: "admin" });
}

describe("dispatch secrets handling", () => {
  it("rejects an inline secret in the create payload", async () => {
    const tok = adminToken(harness.cohortA.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/cohorts/${harness.cohortA.id}/dispatch/targets`,
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: {
        name: "p",
        url: "https://x.test",
        authMode: "bearer",
        // SMUGGLED inline secret — must be rejected.
        auth_secret: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        authSecretRef: "REF",
        artifactSelectors: ["one_sheet"],
        triggerOn: ["final"],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("inline_secret_forbidden");
  });

  it("accepts a target with only authSecretRef", async () => {
    const tok = adminToken(harness.cohortA.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/cohorts/${harness.cohortA.id}/dispatch/targets`,
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: {
        name: "p",
        url: "https://x.test",
        authMode: "bearer",
        authSecretRef: "PORTAL_TOKEN_X",
        artifactSelectors: ["one_sheet"],
        triggerOn: ["final"],
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects bearer authMode with no authSecretRef", async () => {
    const tok = adminToken(harness.cohortA.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/cohorts/${harness.cohortA.id}/dispatch/targets`,
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: {
        name: "p",
        url: "https://x.test",
        authMode: "bearer",
        // missing authSecretRef
        artifactSelectors: ["one_sheet"],
        triggerOn: ["final"],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("smuggling 'authorization' field is rejected", async () => {
    const tok = adminToken(harness.cohortA.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/cohorts/${harness.cohortA.id}/dispatch/targets`,
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: {
        name: "p",
        url: "https://x.test",
        authMode: "bearer",
        authSecretRef: "REF",
        Authorization: "Bearer leaked-token",
        artifactSelectors: ["one_sheet"],
        triggerOn: ["final"],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH also rejects inline secrets", async () => {
    const [row] = await harness.db
      .insert(schema.dispatchTargets)
      .values({
        cohortId: harness.cohortA.id,
        name: "patch-me",
        url: "https://x.test",
        authMode: "none",
        artifactSelectors: ["one_sheet"],
        retryPolicy: { maxAttempts: 1, backoffSeconds: [1] },
        triggerOn: ["final"],
      })
      .returning();
    if (!row) throw new Error("seed failed");

    const tok = adminToken(harness.cohortA.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/dispatch/targets/${row.id}`,
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: { secret: "leaked" },
    });
    expect(res.statusCode).toBe(400);
  });
});
