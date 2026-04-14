import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckpointReport } from "@kiln/shared";
import { and, eq } from "drizzle-orm";
import {
  closeStoreCheckpointDb,
  storeCheckpoint,
} from "../../grading/src/activities/store-checkpoint.js";
import * as gradingSchema from "../../grading/src/db/schema.js";
import { closeDb } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

/**
 * Integration test for `storeCheckpoint`:
 *   - TTL default (7 days when cohort config has no override)
 *   - `persist: true` → expires_at === null
 *   - `pipeline_usage_events` row emitted with pipeline_type="checkpoint"
 *   - `cohort.config.checkpoint_retention_days` honoured
 */

let harness: TestHarness;
let submissionId: string;

const baseReport: CheckpointReport = {
  student_id: "u-1",
  cohort_id: "c-1",
  week: 1,
  project_key: "proj",
  checkpoint_kind: "mid-week",
  generated_at: new Date().toISOString(),
  overall_status: "at-risk",
  overall_summary: "mock",
  gaps: [
    {
      criterion: "Ships",
      status: "at-risk",
      indicative_score: null,
      max_points: 25,
      recommendations: [],
      evidence: [],
      summary: "mock",
    },
  ],
  evaluation_coverage: {
    docker_build: "missing",
    tests_run: "skipped",
    harness_logs_present: false,
    sonar_included: false,
    files_considered: 0,
  },
  ai_usage_snapshot: { total_llm_calls: 0, distinct_tools: [], sophistication: null },
  top_priorities: [],
  commits_considered: 0,
  harness_entries_considered: 0,
  model: "claude-sonnet-4-6",
  pipeline_version: "kiln-phase6-checkpoint",
};

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://kiln:kiln@192.168.147.2:5432/kiln";
  harness = await setupHarness();
}, 30_000);

beforeEach(async () => {
  // Insert a fresh checkpoint submission per test (FK required).
  const [sub] = await harness.db
    .insert(schema.submissions)
    .values({
      userId: harness.studentA.id,
      weekId: harness.weekA.id,
      repoUrl: "https://example.test/repo.git",
      commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      type: "checkpoint",
      stage: null,
      status: "processing",
    })
    .returning();
  if (!sub) throw new Error("submission insert failed");
  submissionId = sub.id;
});

afterAll(async () => {
  await closeStoreCheckpointDb();
  await closeDb();
  await harness.close();
});

describe("storeCheckpoint", () => {
  it("applies default 7-day TTL when cohort config has no override", async () => {
    const result = await storeCheckpoint({
      submissionId,
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      report: baseReport,
      sonarMetrics: null,
      llmCallDetails: [
        {
          call_id: "ck-1",
          model: "claude-sonnet-4-6",
          purpose: "checkpoint-analysis",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          latency_ms: 10,
          estimated_cost_usd: 0.001,
          started_at: new Date().toISOString(),
        },
      ],
      durations: { gitCloneMs: 5, dockerBuildMs: 0, sonarqubeScanMs: 3 },
      pipelineStartedAt: new Date().toISOString(),
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "claude-sonnet-4-6",
      persist: false,
      partialBuildLogs: null,
    });

    expect(result.checkpointId).toBeDefined();
    expect(result.expiresAt).not.toBeNull();
    const [row] = await harness.db
      .select()
      .from(gradingSchema.checkpoints)
      .where(eq(gradingSchema.checkpoints.id, result.checkpointId));
    expect(row?.expiresAt).not.toBeNull();
    if (row?.expiresAt) {
      const ageDays = (row.expiresAt.getTime() - Date.now()) / 86400_000;
      expect(ageDays).toBeGreaterThan(6.9);
      expect(ageDays).toBeLessThan(7.1);
    }
  });

  it("persist=true sets expires_at to null", async () => {
    const result = await storeCheckpoint({
      submissionId,
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      report: baseReport,
      sonarMetrics: null,
      llmCallDetails: [
        {
          call_id: "ck-2",
          model: "claude-sonnet-4-6",
          purpose: "checkpoint-analysis",
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          latency_ms: 5,
          estimated_cost_usd: 0.0001,
          started_at: new Date().toISOString(),
        },
      ],
      durations: { gitCloneMs: 5, dockerBuildMs: 0, sonarqubeScanMs: 3 },
      pipelineStartedAt: new Date().toISOString(),
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "claude-sonnet-4-6",
      persist: true,
      partialBuildLogs: null,
    });

    expect(result.expiresAt).toBeNull();
    const [row] = await harness.db
      .select()
      .from(gradingSchema.checkpoints)
      .where(eq(gradingSchema.checkpoints.id, result.checkpointId));
    expect(row?.expiresAt).toBeNull();
  });

  it("emits pipeline_usage_events with pipeline_type='checkpoint'", async () => {
    await storeCheckpoint({
      submissionId,
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      report: baseReport,
      sonarMetrics: null,
      llmCallDetails: [
        {
          call_id: "ck-3",
          model: "claude-sonnet-4-6",
          purpose: "checkpoint-analysis",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          latency_ms: 10,
          estimated_cost_usd: 0.0025,
          started_at: new Date().toISOString(),
        },
      ],
      durations: { gitCloneMs: 5, dockerBuildMs: 0, sonarqubeScanMs: 3 },
      pipelineStartedAt: new Date().toISOString(),
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "claude-sonnet-4-6",
      persist: false,
      partialBuildLogs: null,
    });

    const usageRows = await harness.db
      .select()
      .from(schema.pipelineUsageEvents)
      .where(
        and(
          eq(schema.pipelineUsageEvents.submissionId, submissionId),
          eq(schema.pipelineUsageEvents.pipelineType, "checkpoint"),
        ),
      );
    expect(usageRows.length).toBeGreaterThan(0);
    const evt = usageRows[0];
    expect(evt?.modelVersion).toBe("claude-sonnet-4-6");
    // Ensure no Opus leakage in the emitted llmCalls.
    const calls = (evt?.llmCalls ?? []) as Array<{ model: string }>;
    for (const call of calls) {
      expect(call.model.toLowerCase()).not.toContain("opus");
    }
  });

  it("honours cohort.config.checkpoint_retention_days", async () => {
    // Set cohortA retention to 2 days.
    await harness.db
      .update(schema.cohorts)
      .set({ config: { checkpoint_retention_days: 2, checkpoints_enabled: true } })
      .where(eq(schema.cohorts.id, harness.cohortA.id));

    const result = await storeCheckpoint({
      submissionId,
      cohortId: harness.cohortA.id,
      weekId: harness.weekA.id,
      userId: harness.studentA.id,
      report: baseReport,
      sonarMetrics: null,
      llmCallDetails: [],
      durations: { gitCloneMs: 5, dockerBuildMs: 0, sonarqubeScanMs: 3 },
      pipelineStartedAt: new Date().toISOString(),
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "claude-sonnet-4-6",
      persist: false,
      partialBuildLogs: null,
    });

    const [row] = await harness.db
      .select()
      .from(gradingSchema.checkpoints)
      .where(eq(gradingSchema.checkpoints.id, result.checkpointId));
    if (row?.expiresAt) {
      const ageDays = (row.expiresAt.getTime() - Date.now()) / 86400_000;
      expect(ageDays).toBeGreaterThan(1.9);
      expect(ageDays).toBeLessThan(2.1);
    }

    // Reset cohort config for other tests.
    await harness.db
      .update(schema.cohorts)
      .set({ config: { checkpoint_retention_days: 7, checkpoints_enabled: true } })
      .where(eq(schema.cohorts.id, harness.cohortA.id));
  });
});
