import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { type KilnDb, closeDb, getDb, schema } from "../db/index.js";

/**
 * Daily usage rollup job.
 *
 * Plan ref: Phase 7 §1 (lines 1064-1083).
 *
 * What this does:
 *   1. For a given date (default: yesterday UTC), aggregate
 *      `pipeline_usage_events` into `usage_daily_rollups`.
 *      One row per `(cohortId, date, pipelineType)`, idempotent via the
 *      `unique(cohort_id, date, pipeline_type)` index + ON CONFLICT.
 *   2. Evaluate alert conditions for the same window and insert rows into
 *      `usage_alerts`. Dedupe: never insert a second alert if an
 *      unacknowledged alert with the same `(cohort_id, alert_type, date)`
 *      already exists — keep `created_at` from the original.
 *
 * DEFERRED:
 *   - Real Temporal Schedule wiring. For MVP this is invokable. Phase 8
 *     wires it into a daily Schedule. Until then, run manually:
 *
 *         bun run apps/api/src/jobs/rollup-usage.ts [YYYY-MM-DD]
 *
 *   - Real Slack/email notifications. Alerts land in the DB only.
 *   - Real Anthropic dashboard reconciliation (<10% drift). Manual.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RollupStats {
  date: string; // YYYY-MM-DD
  rollupRowsWritten: number;
  alertsInserted: number;
  alertsDeduped: number;
}

export interface AlertSeed {
  cohortId: string | null;
  alertType: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  // The "date" used for dedup — same window the alert was computed against.
  date: string;
}

// LLM call shape stored inside `pipeline_usage_events.llm_calls`. The full
// schema lives in `@kiln/shared` (LLMCallDetailSchema) but we keep a narrow
// local view to avoid a cross-package import for a single field set.
interface LlmCallRecord {
  model?: string;
  purpose?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

// Statuses that count as a successful run. `store-results.ts` writes
// `"graded"` on grading paths; `store-checkpoint.ts` writes `"completed"`
// on checkpoint paths. Both are success.
const SUCCESS_STATUSES = new Set(["graded", "completed", "success"]);
const FAILED_STATUSES = new Set(["failed", "error", "errored"]);

// ---------------------------------------------------------------------------
// Date helpers — everything is UTC-day boundaries.
// ---------------------------------------------------------------------------

function toUtcDateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function yesterdayUtc(now: Date = new Date()): Date {
  const d = startOfUtcDay(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runDailyRollup(date: Date = yesterdayUtc()): Promise<RollupStats> {
  const db = getDb();
  const dayStart = startOfUtcDay(date);
  const dayEnd = endOfUtcDay(date);
  const dateKey = toUtcDateKey(dayStart);

  const stats: RollupStats = {
    date: dateKey,
    rollupRowsWritten: 0,
    alertsInserted: 0,
    alertsDeduped: 0,
  };

  // 1. Pull all events that started inside the day window.
  const events = await db
    .select()
    .from(schema.pipelineUsageEvents)
    .where(
      and(
        gte(schema.pipelineUsageEvents.startedAt, dayStart),
        lt(
          schema.pipelineUsageEvents.startedAt,
          new Date(dayEnd.getTime() + 1), // inclusive end
        ),
      ),
    );

  if (events.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[rollup-usage] no events for ${dateKey}`);
    return stats;
  }

  // 2. Group by (cohortId, pipelineType) and aggregate.
  type Bucket = {
    cohortId: string;
    pipelineType: string;
    runs: number;
    successful: number;
    failed: number;
    students: Set<string>;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    durations: number[];
    artifactBytes: number[];
  };
  const buckets = new Map<string, Bucket>();

  for (const ev of events) {
    const key = `${ev.cohortId}|${ev.pipelineType}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        cohortId: ev.cohortId,
        pipelineType: ev.pipelineType,
        runs: 0,
        successful: 0,
        failed: 0,
        students: new Set<string>(),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        durations: [],
        artifactBytes: [],
      };
      buckets.set(key, b);
    }
    b.runs += 1;
    if (SUCCESS_STATUSES.has(ev.status)) b.successful += 1;
    else if (FAILED_STATUSES.has(ev.status)) b.failed += 1;
    b.students.add(ev.userId);
    b.inputTokens += ev.totalInputTokens;
    b.outputTokens += ev.totalOutputTokens;
    b.cacheReadTokens += ev.totalCacheReadTokens;
    b.costUsd += ev.totalEstimatedCostUsd;
    b.durations.push(ev.durationMs);
    b.artifactBytes.push(ev.artifactStorageBytes);
  }

  // 3. Upsert rollup rows.
  for (const b of buckets.values()) {
    const avgDuration = mean(b.durations);
    const p95Duration = percentile(b.durations, 0.95);
    const avgArtifact = mean(b.artifactBytes);

    await db
      .insert(schema.usageDailyRollups)
      .values({
        cohortId: b.cohortId,
        date: dateKey,
        pipelineType: b.pipelineType,
        totalRuns: b.runs,
        successfulRuns: b.successful,
        failedRuns: b.failed,
        uniqueStudents: b.students.size,
        totalInputTokens: b.inputTokens,
        totalOutputTokens: b.outputTokens,
        totalCacheReadTokens: b.cacheReadTokens,
        totalEstimatedCostUsd: b.costUsd,
        avgDurationMs: Math.round(avgDuration),
        p95DurationMs: Math.round(p95Duration),
        avgArtifactStorageBytes: Math.round(avgArtifact),
      })
      .onConflictDoUpdate({
        target: [
          schema.usageDailyRollups.cohortId,
          schema.usageDailyRollups.date,
          schema.usageDailyRollups.pipelineType,
        ],
        set: {
          totalRuns: b.runs,
          successfulRuns: b.successful,
          failedRuns: b.failed,
          uniqueStudents: b.students.size,
          totalInputTokens: b.inputTokens,
          totalOutputTokens: b.outputTokens,
          totalCacheReadTokens: b.cacheReadTokens,
          totalEstimatedCostUsd: b.costUsd,
          avgDurationMs: Math.round(avgDuration),
          p95DurationMs: Math.round(p95Duration),
          avgArtifactStorageBytes: Math.round(avgArtifact),
        },
      });
    stats.rollupRowsWritten += 1;
  }

  // 4. Evaluate alert conditions.
  const alertSeeds = await evaluateAlerts(db, events, dateKey);
  for (const seed of alertSeeds) {
    const inserted = await upsertAlert(db, seed);
    if (inserted) stats.alertsInserted += 1;
    else stats.alertsDeduped += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[rollup-usage] date=${dateKey} rollup_rows=${stats.rollupRowsWritten} alerts_new=${stats.alertsInserted} alerts_dedup=${stats.alertsDeduped}`,
  );

  return stats;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;
  // Linear interpolation between closest ranks (NIST method).
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (rank - lo);
}

// ---------------------------------------------------------------------------
// Alert evaluation
// ---------------------------------------------------------------------------

type EventRow = typeof schema.pipelineUsageEvents.$inferSelect;

async function evaluateAlerts(
  db: KilnDb,
  events: EventRow[],
  dateKey: string,
): Promise<AlertSeed[]> {
  const seeds: AlertSeed[] = [];

  // Group events by cohort for easier evaluation.
  const byCohort = new Map<string, EventRow[]>();
  for (const ev of events) {
    const arr = byCohort.get(ev.cohortId) ?? [];
    arr.push(ev);
    byCohort.set(ev.cohortId, arr);
  }

  for (const [cohortId, cohortEvents] of byCohort) {
    // ---- Anomaly 1: single student >3× cohort avg cost --------------------
    const totalCost = cohortEvents.reduce((acc, e) => acc + e.totalEstimatedCostUsd, 0);
    const avgCost = totalCost / cohortEvents.length;
    if (avgCost > 0) {
      const perStudent = new Map<string, number>();
      for (const e of cohortEvents) {
        perStudent.set(e.userId, (perStudent.get(e.userId) ?? 0) + e.totalEstimatedCostUsd);
      }
      for (const [userId, cost] of perStudent) {
        if (cost > 3 * avgCost) {
          seeds.push({
            cohortId,
            alertType: "student_cost_outlier",
            severity: "info",
            title: "Student cost outlier (>3x cohort avg)",
            detail: JSON.stringify({
              userId,
              studentCostUsd: round4(cost),
              cohortAvgCostUsd: round4(avgCost),
              multiplier: round4(cost / avgCost),
              date: dateKey,
            }),
            date: dateKey,
          });
        }
      }
    }

    // ---- Anomaly 2: cache hit rate <40% over 24h --------------------------
    const sumCacheRead = cohortEvents.reduce((a, e) => a + e.totalCacheReadTokens, 0);
    const sumInput = cohortEvents.reduce((a, e) => a + e.totalInputTokens, 0);
    const denom = sumInput + sumCacheRead;
    if (denom > 0) {
      const cacheHitRate = sumCacheRead / denom;
      if (cacheHitRate < 0.4) {
        seeds.push({
          cohortId,
          alertType: "cache_hit_rate_low",
          severity: "warning",
          title: "Cache hit rate dropped below 40%",
          detail: JSON.stringify({
            cacheHitRate: round4(cacheHitRate),
            cacheReadTokens: sumCacheRead,
            inputTokens: sumInput,
            date: dateKey,
          }),
          date: dateKey,
        });
      }
    }

    // ---- Anomaly 3: failure rate >10% in 24h ------------------------------
    const failedCount = cohortEvents.filter((e) => FAILED_STATUSES.has(e.status)).length;
    const totalCount = cohortEvents.length;
    if (totalCount > 0) {
      const failureRate = failedCount / totalCount;
      if (failureRate > 0.1) {
        seeds.push({
          cohortId,
          alertType: "failure_rate_high",
          severity: "critical",
          title: "Pipeline failure rate >10% in 24h",
          detail: JSON.stringify({
            failureRate: round4(failureRate),
            failed: failedCount,
            total: totalCount,
            date: dateKey,
          }),
          date: dateKey,
        });
      }
    }

    // ---- Anomaly 4: spend spike >2× 7-day avg -----------------------------
    // Compare today's cost to the rolling 7-day avg from `usage_daily_rollups`
    // (excluding today). If we have <3 historical days we skip — too noisy.
    const todayCost = cohortEvents.reduce((a, e) => a + e.totalEstimatedCostUsd, 0);
    const sevenDaysAgo = new Date(`${dateKey}T00:00:00Z`);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
    const sevenDaysAgoKey = toUtcDateKey(sevenDaysAgo);
    const prevRollups = await db
      .select({
        date: schema.usageDailyRollups.date,
        cost: schema.usageDailyRollups.totalEstimatedCostUsd,
      })
      .from(schema.usageDailyRollups)
      .where(
        and(
          eq(schema.usageDailyRollups.cohortId, cohortId),
          gte(schema.usageDailyRollups.date, sevenDaysAgoKey),
          lt(schema.usageDailyRollups.date, dateKey),
        ),
      );
    if (prevRollups.length >= 3) {
      // Sum cost per day across pipeline types.
      const perDay = new Map<string, number>();
      for (const r of prevRollups) {
        perDay.set(r.date, (perDay.get(r.date) ?? 0) + r.cost);
      }
      const dailyCosts = [...perDay.values()];
      const avg7d = mean(dailyCosts);
      if (avg7d > 0 && todayCost > 2 * avg7d) {
        seeds.push({
          cohortId,
          alertType: "spend_spike",
          severity: "warning",
          title: "Daily spend >2× 7-day rolling average",
          detail: JSON.stringify({
            todayUsd: round4(todayCost),
            sevenDayAvgUsd: round4(avg7d),
            multiplier: round4(todayCost / avg7d),
            date: dateKey,
          }),
          date: dateKey,
        });
      }
    }

    // ---- Anomaly 5: Opus tokens in non-synthesis calls --------------------
    // The synthesis purpose in this codebase is "generate-one-sheet" (Pass-3).
    // Any LLM call with model containing "opus" but a different purpose is a
    // critical leak — Opus is supposed to be reserved for the synthesis pass.
    const SYNTHESIS_PURPOSE = "generate-one-sheet";
    let opusLeaks = 0;
    const offendingPurposes = new Set<string>();
    for (const e of cohortEvents) {
      const calls = (e.llmCalls ?? []) as LlmCallRecord[];
      for (const call of calls) {
        const model = (call.model ?? "").toLowerCase();
        const purpose = call.purpose ?? "";
        if (model.includes("opus") && purpose !== SYNTHESIS_PURPOSE) {
          opusLeaks += 1;
          offendingPurposes.add(purpose || "unknown");
        }
      }
    }
    if (opusLeaks > 0) {
      seeds.push({
        cohortId,
        alertType: "opus_leak_non_synthesis",
        severity: "critical",
        title: "Opus tokens used outside synthesis pass",
        detail: JSON.stringify({
          opusCallCount: opusLeaks,
          offendingPurposes: [...offendingPurposes],
          date: dateKey,
        }),
        date: dateKey,
      });
    }
  }

  return seeds;
}

/**
 * Insert an alert if no unacknowledged alert with the same
 * `(cohort_id, alert_type, date-from-detail)` already exists.
 *
 * Returns `true` if a row was actually inserted, `false` if it was
 * deduplicated against an existing unacknowledged alert.
 */
export async function upsertAlert(db: KilnDb, seed: AlertSeed): Promise<boolean> {
  const existing = await db
    .select({ id: schema.usageAlerts.id, detail: schema.usageAlerts.detail })
    .from(schema.usageAlerts)
    .where(
      and(
        seed.cohortId === null
          ? isNull(schema.usageAlerts.cohortId)
          : eq(schema.usageAlerts.cohortId, seed.cohortId),
        eq(schema.usageAlerts.alertType, seed.alertType),
        isNull(schema.usageAlerts.acknowledgedAt),
      ),
    );

  // Match on date inside detail blob to allow same alert type to fire on
  // different days without dedup. We use a simple substring check; the
  // detail JSON always contains `"date":"YYYY-MM-DD"`.
  const dateNeedle = `"date":"${seed.date}"`;
  const dup = existing.find((row) => row.detail.includes(dateNeedle));
  if (dup) return false;

  await db.insert(schema.usageAlerts).values({
    cohortId: seed.cohortId,
    alertType: seed.alertType,
    severity: seed.severity,
    title: seed.title,
    detail: seed.detail,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// `sql` import is only used so eslint doesn't strip it — keep this hook
// for future raw-SQL fragments without churning imports. The actual
// percentile + avg computations run in JS for portability.
void sql;

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const arg = process.argv[2];
  let date: Date;
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    date = new Date(`${arg}T00:00:00Z`);
  } else {
    date = yesterdayUtc();
  }
  try {
    const stats = await runDailyRollup(date);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(stats));
  } finally {
    await closeDb();
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("rollup-usage.ts") || entry.endsWith("rollup-usage.js")) {
  void main();
}
