import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runCheckpointCleanup } from "../src/jobs/checkpoint-cleanup.js";
import { closeDb } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { setupHarness, type TestHarness } from "./fixtures.js";

/**
 * End-to-end cleanup test:
 *   - Seed two checkpoints (one expired, one fresh)
 *   - Seed a persisted checkpoint (expires_at = NULL)
 *   - Create artifact dirs for all three
 *   - Run cleanup
 *   - Assert only the expired row + its artifact dir are gone
 */

let harness: TestHarness;
let tmpStorage: string;

async function insertCheckpoint(
  harness: TestHarness,
  submissionId: string,
  expiresAt: Date | null,
): Promise<string> {
  const [row] = await harness.db
    .insert(schema.checkpoints)
    .values({
      submissionId,
      report: { mock: true },
      sonarMetrics: null,
      rubricVersion: "rv",
      promptVersion: "pv",
      modelVersion: "claude-sonnet-4-6",
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("checkpoint insert failed");
  return row.id;
}

async function insertSubmission(harness: TestHarness): Promise<string> {
  const [s] = await harness.db
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
  if (!s) throw new Error("submission insert failed");
  return s.id;
}

async function seedArtifactDir(
  base: string,
  cohortId: string,
  checkpointId: string,
  bytes: number,
): Promise<void> {
  const dir = path.join(base, "cohorts", cohortId, "checkpoints", checkpointId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "checkpoint-report.json"), "x".repeat(bytes));
}

async function exists(fp: string): Promise<boolean> {
  try {
    await stat(fp);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://kiln:kiln@192.168.147.2:5432/kiln";
  harness = await setupHarness();
  // Use an isolated tmp dir per test run so we don't clobber other tests'
  // storage.
  tmpStorage = path.join(
    process.env.TMPDIR ?? "/tmp",
    `kiln-cleanup-${Math.random().toString(36).slice(2, 10)}`,
  );
  process.env.STORAGE_PATH = tmpStorage;
}, 30_000);

beforeEach(async () => {
  // Clean the checkpoints table — fixtures already truncates everything
  // in setupHarness, but that's only called once.
  await harness.db.delete(schema.checkpoints);
});

afterAll(async () => {
  await closeDb();
  await harness.close();
});

describe("runCheckpointCleanup", () => {
  it("deletes expired rows + artifacts and preserves fresh + persisted ones", async () => {
    const subExpired = await insertSubmission(harness);
    const subFresh = await insertSubmission(harness);
    const subPersisted = await insertSubmission(harness);

    const past = new Date(Date.now() - 86400_000);
    const future = new Date(Date.now() + 86400_000);

    const idExpired = await insertCheckpoint(harness, subExpired, past);
    const idFresh = await insertCheckpoint(harness, subFresh, future);
    const idPersisted = await insertCheckpoint(harness, subPersisted, null);

    await seedArtifactDir(tmpStorage, harness.cohortA.id, idExpired, 1024);
    await seedArtifactDir(tmpStorage, harness.cohortA.id, idFresh, 512);
    await seedArtifactDir(tmpStorage, harness.cohortA.id, idPersisted, 256);

    const stats = await runCheckpointCleanup();

    expect(stats.checkpointsDeleted).toBe(1);
    expect(stats.deletedCheckpointIds).toContain(idExpired);
    expect(stats.bytesFreed).toBeGreaterThanOrEqual(1024);

    // DB state.
    const rowsRemaining = await harness.db.select().from(schema.checkpoints);
    const ids = rowsRemaining.map((r) => r.id);
    expect(ids).not.toContain(idExpired);
    expect(ids).toContain(idFresh);
    expect(ids).toContain(idPersisted);

    // Artifact state.
    expect(
      await exists(path.join(tmpStorage, "cohorts", harness.cohortA.id, "checkpoints", idExpired)),
    ).toBe(false);
    expect(
      await exists(path.join(tmpStorage, "cohorts", harness.cohortA.id, "checkpoints", idFresh)),
    ).toBe(true);
    expect(
      await exists(
        path.join(tmpStorage, "cohorts", harness.cohortA.id, "checkpoints", idPersisted),
      ),
    ).toBe(true);

    // The expired submission should be marked status="expired".
    const [sub] = await harness.db
      .select()
      .from(schema.submissions)
      .where(eq(schema.submissions.id, subExpired));
    expect(sub?.status).toBe("expired");

    // The fresh one is untouched.
    const [freshSub] = await harness.db
      .select()
      .from(schema.submissions)
      .where(eq(schema.submissions.id, subFresh));
    expect(freshSub?.status).not.toBe("expired");
  });

  it("returns zero stats when nothing is expired", async () => {
    const stats = await runCheckpointCleanup();
    expect(stats.checkpointsDeleted).toBe(0);
    expect(stats.bytesFreed).toBe(0);
  });
});
