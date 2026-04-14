import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DispatchTarget } from "@kiln/shared";
import type {
  BuildPayloadResult,
  HttpPostResult,
  RecordDispatchEventInput,
} from "../src/activities/dispatch/index.js";
import type { DispatchSingleTargetResult } from "../src/workflows/dispatch-single-target.js";

/**
 * Phase 7.5 — retry semantics for dispatchSingleTarget.
 *
 * Scenarios:
 *   [200]                      → 1 row, success
 *   [500, 500, 200]            → 3 rows, last success
 *   [500, 500, 500, 500, 500]  → 5 rows, last dead_letter
 *   [401]                      → 1 row, failed (no retry)
 *   [429, 200]                 → 2 rows, last success (429 is transient)
 *
 * Uses a fake httpPostWithAuth driven by a scripted queue. The
 * recordDispatchEvent activity is also a mock that captures rows.
 */

const workflowsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/workflows",
);

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  if (env) await env.teardown();
});

const TARGET: DispatchTarget = {
  id: "00000000-0000-0000-0000-000000000001",
  cohortId: "00000000-0000-0000-0000-0000000000a1",
  weekId: null,
  name: "test-target",
  url: "https://example.test/dispatch",
  authMode: "none",
  authSecretRef: null,
  artifactSelectors: ["one_sheet"],
  transformTemplate: null,
  retryPolicy: { maxAttempts: 5, backoffSeconds: [1, 1, 1, 1, 1] },
  triggerOn: ["final"],
  enabled: true,
  createdAt: null,
  updatedAt: null,
};

interface ScenarioActivities {
  scriptedResponses: Array<HttpPostResult>;
  recorded: RecordDispatchEventInput[];
}

function buildActivities(state: ScenarioActivities) {
  let idx = 0;
  return {
    buildPayload: async (): Promise<BuildPayloadResult> => ({
      payload: { hello: "world" },
      payloadBytes: 17,
      sizeCapped: false,
    }),
    httpPostWithAuth: async (): Promise<HttpPostResult> => {
      const r = state.scriptedResponses[idx] ?? state.scriptedResponses[state.scriptedResponses.length - 1];
      idx++;
      return r;
    },
    recordDispatchEvent: async (
      input: RecordDispatchEventInput,
    ): Promise<{ eventId: string }> => {
      state.recorded.push(input);
      return { eventId: `ev-${state.recorded.length}` };
    },
    resolveSecretActivity: async (): Promise<{ ok: true; value: string }> => ({
      ok: true,
      value: "unused",
    }),
    // Unused activities to satisfy the workflow bundle.
    cloneRepo: async () => {
      throw new Error("not used");
    },
    buildDocker: async () => {
      throw new Error("not used");
    },
    runTests: async () => {
      throw new Error("not used");
    },
    normalizeLogs: async () => {
      throw new Error("not used");
    },
    analyzeCode: async () => {
      throw new Error("not used");
    },
    analyzeCodeLight: async () => {
      throw new Error("not used");
    },
    generateOneSheet: async () => {
      throw new Error("not used");
    },
    generateCheckpointReport: async () => {
      throw new Error("not used");
    },
    storeResults: async () => {
      throw new Error("not used");
    },
    storeCheckpoint: async () => {
      throw new Error("not used");
    },
    loadTargets: async () => {
      throw new Error("not used");
    },
  };
}

async function runDispatchScenario(
  scriptedResponses: HttpPostResult[],
): Promise<{ result: DispatchSingleTargetResult; recorded: RecordDispatchEventInput[] }> {
  const state: ScenarioActivities = { scriptedResponses, recorded: [] };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: `dst-${Math.random().toString(36).slice(2, 10)}`,
    workflowsPath,
    activities: buildActivities(state),
  });
  let result: DispatchSingleTargetResult | null = null;
  await worker.runUntil(async () => {
    result = (await env.client.workflow.execute("dispatchSingleTarget", {
      taskQueue: worker.options.taskQueue,
      workflowId: `dst-${Math.random().toString(36).slice(2, 10)}`,
      args: [
        {
          target: TARGET,
          submissionId: "00000000-0000-0000-0000-000000000099",
          cohortId: TARGET.cohortId,
        },
      ],
    })) as DispatchSingleTargetResult;
  });
  if (!result) throw new Error("no result");
  return { result, recorded: state.recorded };
}

describe("dispatchSingleTarget retry semantics", () => {
  it("[200] → 1 success row", async () => {
    const { result, recorded } = await runDispatchScenario([
      { httpStatus: 200, latencyMs: 5, responseBody: "{}" },
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status).toBe("success");
    expect(result.finalStatus).toBe("success");
    expect(result.attempts).toBe(1);
  });

  it("[500, 500, 200] → 3 rows, last success", async () => {
    const { result, recorded } = await runDispatchScenario([
      { httpStatus: 500, latencyMs: 1, responseBody: "boom" },
      { httpStatus: 500, latencyMs: 1, responseBody: "boom" },
      { httpStatus: 200, latencyMs: 2, responseBody: '{"job_id":"j-1"}' },
    ]);
    expect(recorded).toHaveLength(3);
    expect(recorded[0]?.status).toBe("retrying");
    expect(recorded[1]?.status).toBe("retrying");
    expect(recorded[2]?.status).toBe("success");
    expect(result.finalStatus).toBe("success");
    expect(result.responseRef).toBe("j-1");
  }, 30_000);

  it("[500 ×5] → 5 rows, last dead_letter", async () => {
    const fives: HttpPostResult[] = Array.from({ length: 6 }, () => ({
      httpStatus: 500,
      latencyMs: 1,
      responseBody: "boom",
    }));
    const { result, recorded } = await runDispatchScenario(fives);
    expect(recorded).toHaveLength(5);
    expect(recorded[recorded.length - 1]?.status).toBe("dead_letter");
    expect(result.finalStatus).toBe("dead_letter");
    expect(result.attempts).toBe(5);
  }, 30_000);

  it("[401] → 1 row failed, no retry", async () => {
    const { result, recorded } = await runDispatchScenario([
      { httpStatus: 401, latencyMs: 1, responseBody: "unauthorized" },
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status).toBe("failed");
    expect(result.finalStatus).toBe("failed");
    expect(result.attempts).toBe(1);
  });

  it("[429, 200] → 2 rows, 429 is transient, last success", async () => {
    const { result, recorded } = await runDispatchScenario([
      { httpStatus: 429, latencyMs: 1, responseBody: "rate limited" },
      { httpStatus: 200, latencyMs: 2, responseBody: "{}" },
    ]);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.status).toBe("retrying");
    expect(recorded[1]?.status).toBe("success");
    expect(result.finalStatus).toBe("success");
  }, 30_000);

  it("network error → transient retry", async () => {
    const { result, recorded } = await runDispatchScenario([
      { httpStatus: 0, latencyMs: 1, responseBody: "", error: "network: ECONNREFUSED" },
      { httpStatus: 200, latencyMs: 2, responseBody: "{}" },
    ]);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.status).toBe("retrying");
    expect(recorded[0]?.error).toContain("ECONNREFUSED");
    expect(result.finalStatus).toBe("success");
  }, 30_000);

  it("never logs the resolved secret in dispatch_events.error", async () => {
    // Drive an error path with a 500. The resolveSecretActivity returns
    // 'unused' as the secret but should NOT appear anywhere.
    const { recorded } = await runDispatchScenario([
      { httpStatus: 500, latencyMs: 1, responseBody: "boom", error: "x" },
      { httpStatus: 500, latencyMs: 1, responseBody: "boom", error: "x" },
      { httpStatus: 500, latencyMs: 1, responseBody: "boom", error: "x" },
      { httpStatus: 500, latencyMs: 1, responseBody: "boom", error: "x" },
      { httpStatus: 500, latencyMs: 1, responseBody: "boom", error: "x" },
    ]);
    for (const row of recorded) {
      expect(row.error ?? "").not.toContain("unused");
    }
  }, 30_000);
});
