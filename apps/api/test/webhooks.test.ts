import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { closeDb } from "../src/db/index.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

let app: FastifyInstance;
let harness: TestHarness;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://kiln:kiln@192.168.147.2:5432/kiln";
  process.env.JWT_SECRET = "test-secret";
  process.env.GITLAB_WEBHOOK_TOKEN = "test-webhook-token";
  harness = await setupHarness();
  app = await buildServer();
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await harness.close();
  await closeDb();
});

describe("POST /api/webhooks/gl", () => {
  it("rejects a missing token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/gl",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/gl",
      headers: { "x-gitlab-token": "nope" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("ignores a push from an unmatched repo path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/gl",
      headers: {
        "x-gitlab-token": "test-webhook-token",
        "content-type": "application/json",
      },
      payload: {
        object_kind: "push",
        after: "c0ffee",
        project: { path_with_namespace: "random/unrelated/repo" },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "ignored_unmatched_repo" });
  });
});
