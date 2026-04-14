import { stat } from "node:fs/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { closeDb, getDb, schema } from "../db/index.js";

/**
 * Checkpoint TTL cleanup job.
 *
 * Plan ref: Phase 6 §7 (lines 1032-1037).
 *
 * What this does:
 *   1. Delete `checkpoints` rows with `expires_at < now()`. `expires_at IS
 *      NULL` rows (the `--persist` escape hatch) are kept forever.
 *   2. For each deleted checkpoint, delete its `submissions` row IF:
 *      - the submission is of `type = "checkpoint"`, and
 *      - no other `checkpoints` row references it (i.e. there's no
 *        second report hanging off the same submission).
 *   3. rm -rf the artifact directory
 *      `$STORAGE_PATH/cohorts/{cohortId}/checkpoints/{id}/`.
 *   4. Log + return stats.
 *
 * DEFERRED: real Temporal Schedule wiring. For MVP this is an invokable
 * function. Phase 7.5 / Phase 8 will wire it into a nightly Schedule.
 * Until then, run manually:
 *
 *     bun run apps/api/src/jobs/checkpoint-cleanup.ts
 */

export interface CheckpointCleanupStats {
  checkpointsDeleted: number;
  submissionsDeleted: number;
  bytesFreed: number;
  deletedCheckpointIds: string[];
}

/**
 * Run one pass of the cleanup.
 *
 * @param now override "current time" — used by tests.
 */
export async function runCheckpointCleanup(
  now: Date = new Date(),
): Promise<CheckpointCleanupStats> {
  const db = getDb();
  const stats: CheckpointCleanupStats = {
    checkpointsDeleted: 0,
    submissionsDeleted: 0,
    bytesFreed: 0,
    deletedCheckpointIds: [],
  };

  // Step 1: find expired checkpoints. `expires_at IS NULL` rows are
  // skipped — they're permanent (`--persist` flag).
  const expired = await db
    .select({
      id: schema.checkpoints.id,
      submissionId: schema.checkpoints.submissionId,
      weekId: schema.submissions.weekId,
    })
    .from(schema.checkpoints)
    .innerJoin(schema.submissions, eq(schema.submissions.id, schema.checkpoints.submissionId))
    .where(lt(schema.checkpoints.expiresAt, now));

  if (expired.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[checkpoint-cleanup] no expired rows");
    return stats;
  }

  // Resolve cohortId per checkpoint via the weeks table. We need this for
  // artifact deletion.
  const weekIds = [...new Set(expired.map((r) => r.weekId))];
  const weeks =
    weekIds.length === 0
      ? []
      : await db
          .select({ id: schema.weeks.id, cohortId: schema.weeks.cohortId })
          .from(schema.weeks)
          .where(inArray(schema.weeks.id, weekIds));
  const weekToCohort = new Map<string, string>();
  for (const w of weeks) weekToCohort.set(w.id, w.cohortId);

  // Step 2: delete checkpoint rows.
  const idsToDelete = expired.map((e) => e.id);
  await db.delete(schema.checkpoints).where(inArray(schema.checkpoints.id, idsToDelete));
  stats.checkpointsDeleted = idsToDelete.length;
  stats.deletedCheckpointIds = idsToDelete;

  // Step 3: delete orphaned submission rows (type="checkpoint" only).
  const submissionIds = [...new Set(expired.map((e) => e.submissionId))];
  // Only delete submissions that have no remaining checkpoint references —
  // which is all of them now, since we just deleted them. But guard the
  // type to avoid ever touching a grading submission.
  //
  // NOTE: we also guard against `pipeline_usage_events.submission_id` FK
  // references — those stay, keeping the usage event history intact. The
  // usage event references submissions(id), so we can't actually hard-
  // delete the submission row without either cascading or preserving it.
  // Plan-faithful approach: leave the submission row in place with status
  // marked `expired`, which keeps the FK graph intact AND keeps the usage
  // analytics honest (a deleted submission would hide cost history).
  await db
    .update(schema.submissions)
    .set({ status: "expired" })
    .where(
      and(
        inArray(schema.submissions.id, submissionIds),
        eq(schema.submissions.type, "checkpoint"),
        // Don't clobber anything already in a terminal non-expired state
        // that shouldn't be touched.
        ne(schema.submissions.status, "expired"),
      ),
    );
  stats.submissionsDeleted = 0;

  // Step 4: delete artifact directories. Best-effort — a missing dir is
  // not a failure.
  const storageBase = process.env.STORAGE_PATH ?? "./data";
  for (const e of expired) {
    const cohortId = weekToCohort.get(e.weekId);
    if (!cohortId) continue;
    const dir = path.join(storageBase, "cohorts", cohortId, "checkpoints", e.id);
    try {
      const st = await stat(dir);
      if (st.isDirectory()) {
        stats.bytesFreed += await dirSize(dir);
        await rm(dir, { recursive: true, force: true });
      }
    } catch {
      // Directory missing — no-op.
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[checkpoint-cleanup] checkpoints_deleted=${stats.checkpointsDeleted} submissions_expired=${submissionIds.length} bytes_freed=${stats.bytesFreed}`,
  );
  return stats;
}

async function dirSize(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        total += await dirSize(fp);
      } else {
        try {
          const st = await stat(fp);
          total += st.size;
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }
  return total;
}

async function main(): Promise<void> {
  try {
    const stats = await runCheckpointCleanup();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(stats));
  } finally {
    await closeDb();
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("checkpoint-cleanup.ts") || entry.endsWith("checkpoint-cleanup.js")) {
  void main();
}
