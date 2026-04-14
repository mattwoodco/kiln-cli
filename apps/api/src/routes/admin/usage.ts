import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, schema } from "../../db/index.js";
import { type CohortScope, requireRole } from "../../lib/auth.js";

/**
 * Admin usage analytics routes.
 *
 * Plan ref: Phase 7 §2 (lines 1084-1092).
 *
 * MVP simplification: every authenticated `admin` JWT is treated as a
 * super-admin and may query any cohort. The plan calls for a real
 * super-admin distinction tied to an extra JWT claim — that lands in a
 * post-MVP phase. See PROGRESS.md / ISSUES.md.
 *
 * DEFERRED:
 *   - Real super-admin claim (`role: "super_admin"`).
 *   - Real billing-period detection. We use the calendar month for MVP.
 *   - Pricing staleness reconciliation against the Anthropic dashboard.
 *
 * All numeric formatting lives client-side (CLI). These routes return raw
 * numbers so other clients (e.g. a future portal dashboard) can format
 * them however they like.
 */

// ---------------------------------------------------------------------------
// Pricing staleness helper.
//
// Mirrored from `apps/grading/src/lib/pricing.ts` because the api package
// can't import from the grading workspace. KEEP THESE IN SYNC. There is
// a unit test in usage-api.test.ts that fails if they drift.
// ---------------------------------------------------------------------------
export const PRICING_LAST_UPDATED = "2026-04-14";
export const PRICING_STALE_DAYS = 90;

export function pricingIsStale(now: Date = new Date()): boolean {
  const last = new Date(`${PRICING_LAST_UPDATED}T00:00:00Z`);
  const diffMs = now.getTime() - last.getTime();
  const days = diffMs / (1000 * 60 * 60 * 24);
  return days > PRICING_STALE_DAYS;
}

export function pricingWarning(now: Date = new Date()): string | undefined {
  return pricingIsStale(now)
    ? `pricing table last updated ${PRICING_LAST_UPDATED} (>${PRICING_STALE_DAYS} days ago) — costs may be inaccurate`
    : undefined;
}

// ---------------------------------------------------------------------------
// Date range parsing
// ---------------------------------------------------------------------------

const DateRangeQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

interface DateRange {
  from: Date;
  to: Date;
  fromKey: string;
  toKey: string;
}

function defaultRange(now: Date = new Date()): DateRange {
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999),
  );
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  from.setUTCHours(0, 0, 0, 0);
  return {
    from,
    to,
    fromKey: ymd(from),
    toKey: ymd(to),
  };
}

function parseRange(q: { from?: string; to?: string }, now: Date = new Date()): DateRange {
  if (!q.from && !q.to) return defaultRange(now);
  const def = defaultRange(now);
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : def.from;
  const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : def.to;
  return { from, to, fromKey: ymd(from), toKey: ymd(to) };
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Super-admin gate
// ---------------------------------------------------------------------------

/**
 * MVP: every admin is a super-admin. This wrapper is the single place to
 * tighten when a real super_admin role lands.
 */
async function requireSuperAdmin(
  request: Parameters<typeof requireRole>[0],
  reply: Parameters<typeof requireRole>[1],
): Promise<CohortScope | null> {
  return requireRole(request, reply, ["admin"]);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerAdminUsageRoutes(app: FastifyInstance): void {
  // ===========================================================================
  // GET /api/admin/usage/summary — global aggregate
  // ===========================================================================
  app.get("/api/admin/usage/summary", async (request, reply) => {
    const scope = await requireSuperAdmin(request, reply);
    if (!scope) return;
    const parsed = DateRangeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    }
    const range = parseRange(parsed.data);
    const db = getDb();

    const events = await db
      .select()
      .from(schema.pipelineUsageEvents)
      .where(
        and(
          gte(schema.pipelineUsageEvents.startedAt, range.from),
          lte(schema.pipelineUsageEvents.startedAt, range.to),
        ),
      );

    let totalSpend = 0;
    let totalInput = 0;
    let totalCacheRead = 0;
    const runsByType: Record<string, number> = {};
    const spendByModel: Record<string, number> = {};
    const cohortRollup = new Map<string, { spend: number; runs: number }>();

    for (const ev of events) {
      totalSpend += ev.totalEstimatedCostUsd;
      totalInput += ev.totalInputTokens;
      totalCacheRead += ev.totalCacheReadTokens;
      runsByType[ev.pipelineType] = (runsByType[ev.pipelineType] ?? 0) + 1;
      // Model attribution from the model_version column on the row.
      spendByModel[ev.modelVersion] =
        (spendByModel[ev.modelVersion] ?? 0) + ev.totalEstimatedCostUsd;
      const cohort = cohortRollup.get(ev.cohortId) ?? { spend: 0, runs: 0 };
      cohort.spend += ev.totalEstimatedCostUsd;
      cohort.runs += 1;
      cohortRollup.set(ev.cohortId, cohort);
    }

    const denom = totalInput + totalCacheRead;
    const cacheHitRate = denom > 0 ? totalCacheRead / denom : 0;

    // Resolve cohort names + sort top 10 by spend desc.
    const cohortIds = [...cohortRollup.keys()];
    let topCohorts: Array<{ cohortId: string; name: string; spend: number; runs: number }> = [];
    if (cohortIds.length > 0) {
      const rows = await db
        .select({ id: schema.cohorts.id, name: schema.cohorts.name })
        .from(schema.cohorts);
      const nameMap = new Map(rows.map((r) => [r.id, r.name]));
      topCohorts = [...cohortRollup.entries()]
        .map(([cohortId, v]) => ({
          cohortId,
          name: nameMap.get(cohortId) ?? "(unknown)",
          spend: v.spend,
          runs: v.runs,
        }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 10);
    }

    return {
      from: range.fromKey,
      to: range.toKey,
      totalSpend,
      runsByType,
      spendByModel,
      cacheHitRate,
      topCohorts,
      pricingWarning: pricingWarning(),
    };
  });

  // ===========================================================================
  // GET /api/admin/usage/cohorts/:id — per-cohort
  // ===========================================================================
  app.get<{ Params: { id: string } }>("/api/admin/usage/cohorts/:id", async (request, reply) => {
    const scope = await requireSuperAdmin(request, reply);
    if (!scope) return;
    const parsed = DateRangeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    }
    const range = parseRange(parsed.data);
    const db = getDb();

    const events = await db
      .select()
      .from(schema.pipelineUsageEvents)
      .where(
        and(
          eq(schema.pipelineUsageEvents.cohortId, request.params.id),
          gte(schema.pipelineUsageEvents.startedAt, range.from),
          lte(schema.pipelineUsageEvents.startedAt, range.to),
        ),
      );

    let totalSpend = 0;
    const dailyMap = new Map<string, number>();
    const pipelineSplit: Record<string, number> = { grading: 0, checkpoint: 0 };
    const weeklyMap = new Map<string, number>(); // weekId → cost
    for (const ev of events) {
      totalSpend += ev.totalEstimatedCostUsd;
      const d = ymd(new Date(ev.startedAt));
      dailyMap.set(d, (dailyMap.get(d) ?? 0) + ev.totalEstimatedCostUsd);
      pipelineSplit[ev.pipelineType] =
        (pipelineSplit[ev.pipelineType] ?? 0) + ev.totalEstimatedCostUsd;
      weeklyMap.set(ev.weekId, (weeklyMap.get(ev.weekId) ?? 0) + ev.totalEstimatedCostUsd);
    }

    // Resolve weekId → weekNumber for friendly per-week totals.
    const weekIds = [...weeklyMap.keys()];
    let perWeekTotals: Array<{ weekNumber: number; cost: number }> = [];
    if (weekIds.length > 0) {
      const weeks = await db
        .select({ id: schema.weeks.id, weekNumber: schema.weeks.weekNumber })
        .from(schema.weeks)
        .where(eq(schema.weeks.cohortId, request.params.id));
      const map = new Map(weeks.map((w) => [w.id, w.weekNumber]));
      perWeekTotals = [...weeklyMap.entries()]
        .map(([wid, cost]) => ({ weekNumber: map.get(wid) ?? 0, cost }))
        .filter((r) => r.weekNumber > 0)
        .sort((a, b) => a.weekNumber - b.weekNumber);
    }

    const dailySpendCurve = [...dailyMap.entries()]
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      cohortId: request.params.id,
      from: range.fromKey,
      to: range.toKey,
      totalSpend,
      runs: events.length,
      dailySpendCurve,
      perWeekTotals,
      pipelineSplit: {
        grading: pipelineSplit.grading ?? 0,
        checkpoint: pipelineSplit.checkpoint ?? 0,
      },
      pricingWarning: pricingWarning(),
    };
  });

  // ===========================================================================
  // GET /api/admin/usage/cohorts/:id/students — per-student leaderboard
  // ===========================================================================
  app.get<{ Params: { id: string } }>(
    "/api/admin/usage/cohorts/:id/students",
    async (request, reply) => {
      const scope = await requireSuperAdmin(request, reply);
      if (!scope) return;
      const db = getDb();
      const events = await db
        .select()
        .from(schema.pipelineUsageEvents)
        .where(eq(schema.pipelineUsageEvents.cohortId, request.params.id));

      const perUser = new Map<
        string,
        { totalCost: number; totalRuns: number; totalDuration: number }
      >();
      for (const ev of events) {
        const cur = perUser.get(ev.userId) ?? { totalCost: 0, totalRuns: 0, totalDuration: 0 };
        cur.totalCost += ev.totalEstimatedCostUsd;
        cur.totalRuns += 1;
        cur.totalDuration += ev.durationMs;
        perUser.set(ev.userId, cur);
      }

      const userIds = [...perUser.keys()];
      let nameMap = new Map<string, string>();
      if (userIds.length > 0) {
        const rows = await db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users);
        nameMap = new Map(rows.map((r) => [r.id, r.name]));
      }

      const result = [...perUser.entries()]
        .map(([userId, v]) => ({
          userId,
          name: nameMap.get(userId) ?? "(unknown)",
          totalCost: v.totalCost,
          totalRuns: v.totalRuns,
          avgDurationMs: v.totalRuns > 0 ? Math.round(v.totalDuration / v.totalRuns) : 0,
        }))
        .sort((a, b) => b.totalCost - a.totalCost);

      return result;
    },
  );

  // ===========================================================================
  // GET /api/admin/usage/cohorts/:id/weeks/:n — week drilldown
  // ===========================================================================
  app.get<{ Params: { id: string; n: string } }>(
    "/api/admin/usage/cohorts/:id/weeks/:n",
    async (request, reply) => {
      const scope = await requireSuperAdmin(request, reply);
      if (!scope) return;
      const weekNumber = Number(request.params.n);
      if (!Number.isFinite(weekNumber)) {
        return reply.code(400).send({ error: "invalid_week_number" });
      }
      const db = getDb();
      const [week] = await db
        .select({ id: schema.weeks.id })
        .from(schema.weeks)
        .where(
          and(
            eq(schema.weeks.cohortId, request.params.id),
            eq(schema.weeks.weekNumber, weekNumber),
          ),
        )
        .limit(1);
      if (!week) return reply.code(404).send({ error: "week_not_found" });

      const events = await db
        .select()
        .from(schema.pipelineUsageEvents)
        .where(
          and(
            eq(schema.pipelineUsageEvents.cohortId, request.params.id),
            eq(schema.pipelineUsageEvents.weekId, week.id),
          ),
        );

      // Pass-level breakdown by purpose.
      const passBreakdown: Record<string, { calls: number; cost: number }> = {
        pass1: { calls: 0, cost: 0 },
        pass2: { calls: 0, cost: 0 },
        pass3: { calls: 0, cost: 0 },
        codeAnalysis: { calls: 0, cost: 0 },
        other: { calls: 0, cost: 0 },
      };
      let sonarTotal = 0;
      let sonarCount = 0;
      let dockerTotal = 0;
      let dockerCount = 0;
      let totalInput = 0;
      let totalCacheRead = 0;
      let failed = 0;

      for (const ev of events) {
        if (ev.sonarqubeScanDurationMs != null) {
          sonarTotal += ev.sonarqubeScanDurationMs;
          sonarCount += 1;
        }
        if (ev.dockerBuildDurationMs != null) {
          dockerTotal += ev.dockerBuildDurationMs;
          dockerCount += 1;
        }
        totalInput += ev.totalInputTokens;
        totalCacheRead += ev.totalCacheReadTokens;
        if (ev.status === "failed" || ev.status === "error") failed += 1;

        const calls = (ev.llmCalls ?? []) as Array<{
          purpose?: string;
          estimated_cost_usd?: number;
        }>;
        for (const call of calls) {
          const cost = call.estimated_cost_usd ?? 0;
          let bucket: keyof typeof passBreakdown = "other";
          switch (call.purpose) {
            case "analyze-code":
            case "checkpoint-code-analysis":
              bucket = "codeAnalysis";
              break;
            case "analyze-code-light":
              bucket = "pass1";
              break;
            case "summarize-harness-logs":
              bucket = "pass2";
              break;
            case "generate-one-sheet":
            case "generate-checkpoint-report":
            case "checkpoint-analysis":
              bucket = "pass3";
              break;
            default:
              bucket = "other";
          }
          const slot = passBreakdown[bucket];
          if (slot) {
            slot.calls += 1;
            slot.cost += cost;
          }
        }
      }

      const denom = totalInput + totalCacheRead;
      const cacheEfficiency = denom > 0 ? totalCacheRead / denom : 0;
      const failureRate = events.length > 0 ? failed / events.length : 0;

      return {
        cohortId: request.params.id,
        weekNumber,
        passBreakdown,
        sonarqubeScanMs: sonarCount > 0 ? Math.round(sonarTotal / sonarCount) : 0,
        dockerBuildMs: dockerCount > 0 ? Math.round(dockerTotal / dockerCount) : 0,
        cacheEfficiency,
        failureRate,
        runs: events.length,
      };
    },
  );

  // ===========================================================================
  // GET /api/admin/usage/alerts
  // ===========================================================================
  const AlertsQuerySchema = z.object({
    severity: z.enum(["info", "warning", "critical"]).optional(),
    cohort_id: z.string().optional(),
    acknowledged: z.enum(["true", "false"]).optional(),
  });

  app.get("/api/admin/usage/alerts", async (request, reply) => {
    const scope = await requireSuperAdmin(request, reply);
    if (!scope) return;
    const parsed = AlertsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    }
    const db = getDb();
    const conditions = [];
    if (parsed.data.severity) {
      conditions.push(eq(schema.usageAlerts.severity, parsed.data.severity));
    }
    if (parsed.data.cohort_id) {
      conditions.push(eq(schema.usageAlerts.cohortId, parsed.data.cohort_id));
    }
    if (parsed.data.acknowledged === "false") {
      conditions.push(sql`${schema.usageAlerts.acknowledgedAt} IS NULL`);
    } else if (parsed.data.acknowledged === "true") {
      conditions.push(sql`${schema.usageAlerts.acknowledgedAt} IS NOT NULL`);
    } else {
      // Default: only unacknowledged.
      conditions.push(sql`${schema.usageAlerts.acknowledgedAt} IS NULL`);
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = where
      ? await db
          .select()
          .from(schema.usageAlerts)
          .where(where)
          .orderBy(desc(schema.usageAlerts.createdAt))
      : await db.select().from(schema.usageAlerts).orderBy(desc(schema.usageAlerts.createdAt));
    return rows;
  });

  // ===========================================================================
  // POST /api/admin/usage/alerts/:id/acknowledge
  // ===========================================================================
  app.post<{ Params: { id: string } }>(
    "/api/admin/usage/alerts/:id/acknowledge",
    async (request, reply) => {
      const scope = await requireSuperAdmin(request, reply);
      if (!scope) return;
      const db = getDb();
      const [updated] = await db
        .update(schema.usageAlerts)
        .set({ acknowledgedAt: new Date() })
        .where(eq(schema.usageAlerts.id, request.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: "alert_not_found" });
      return updated;
    },
  );

  // ===========================================================================
  // GET /api/admin/usage/forecast
  // ===========================================================================
  const ForecastQuerySchema = z.object({
    cohort_id: z.string().optional(),
  });

  app.get("/api/admin/usage/forecast", async (request, reply) => {
    const scope = await requireSuperAdmin(request, reply);
    if (!scope) return;
    const parsed = ForecastQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    }
    const db = getDb();
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
    const sevenDaysAgoKey = ymd(sevenDaysAgo);
    const todayKey = ymd(now);

    const cond = parsed.data.cohort_id
      ? and(
          eq(schema.usageDailyRollups.cohortId, parsed.data.cohort_id),
          gte(schema.usageDailyRollups.date, sevenDaysAgoKey),
          lt(schema.usageDailyRollups.date, todayKey),
        )
      : and(
          gte(schema.usageDailyRollups.date, sevenDaysAgoKey),
          lt(schema.usageDailyRollups.date, todayKey),
        );

    const rollups = await db.select().from(schema.usageDailyRollups).where(cond);

    // Aggregate cost per day across pipeline types.
    const perDay = new Map<string, number>();
    for (const r of rollups) {
      perDay.set(r.date, (perDay.get(r.date) ?? 0) + r.totalEstimatedCostUsd);
    }
    const dailyCosts = [...perDay.values()];
    const rolling7dAvgUsd =
      dailyCosts.length > 0 ? dailyCosts.reduce((a, b) => a + b, 0) / dailyCosts.length : 0;

    // Current-month spend so far.
    const monthCondBase = and(
      gte(schema.usageDailyRollups.date, ymd(monthStart)),
      lt(schema.usageDailyRollups.date, ymd(nextMonthStart)),
    );
    const monthCond = parsed.data.cohort_id
      ? and(eq(schema.usageDailyRollups.cohortId, parsed.data.cohort_id), monthCondBase)
      : monthCondBase;
    const monthRollups = await db.select().from(schema.usageDailyRollups).where(monthCond);
    let currentMonthSpend = 0;
    for (const r of monthRollups) currentMonthSpend += r.totalEstimatedCostUsd;

    // Days remaining in calendar month (inclusive of today's remainder).
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    const daysRemaining = lastDay.getUTCDate() - now.getUTCDate();

    const projectedMonthEndUsd = currentMonthSpend + rolling7dAvgUsd * daysRemaining;

    return {
      cohortId: parsed.data.cohort_id ?? null,
      rolling7dAvgUsd,
      projectedMonthEndUsd,
      currentMonthSpend,
      daysRemaining,
      pricingWarning: pricingWarning(),
    };
  });

  // ===========================================================================
  // GET /api/admin/usage/export — CSV
  // ===========================================================================
  const ExportQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    cohort_id: z.string().optional(),
  });

  const CSV_COLUMNS = [
    "event_id",
    "cohort_id",
    "week_id",
    "user_id",
    "submission_id",
    "pipeline_type",
    "started_at",
    "completed_at",
    "status",
    "duration_ms",
    "total_input_tokens",
    "total_output_tokens",
    "total_cache_read_tokens",
    "total_cache_write_tokens",
    "total_estimated_cost_usd",
    "sonarqube_scan_ms",
    "docker_build_ms",
    "prompt_version",
    "model_version",
    "rubric_version",
  ] as const;

  app.get("/api/admin/usage/export", async (request, reply) => {
    const scope = await requireSuperAdmin(request, reply);
    if (!scope) return;
    const parsed = ExportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    }
    const range = parseRange(parsed.data);
    const db = getDb();
    const cond = parsed.data.cohort_id
      ? and(
          eq(schema.pipelineUsageEvents.cohortId, parsed.data.cohort_id),
          gte(schema.pipelineUsageEvents.startedAt, range.from),
          lte(schema.pipelineUsageEvents.startedAt, range.to),
        )
      : and(
          gte(schema.pipelineUsageEvents.startedAt, range.from),
          lte(schema.pipelineUsageEvents.startedAt, range.to),
        );
    const rows = await db
      .select()
      .from(schema.pipelineUsageEvents)
      .where(cond)
      .orderBy(schema.pipelineUsageEvents.startedAt);

    const lines: string[] = [];
    lines.push(CSV_COLUMNS.join(","));
    for (const r of rows) {
      const cells = [
        r.id,
        r.cohortId,
        r.weekId,
        r.userId,
        r.submissionId,
        r.pipelineType,
        r.startedAt instanceof Date ? r.startedAt.toISOString() : String(r.startedAt),
        r.completedAt
          ? r.completedAt instanceof Date
            ? r.completedAt.toISOString()
            : String(r.completedAt)
          : "",
        r.status,
        String(r.durationMs),
        String(r.totalInputTokens),
        String(r.totalOutputTokens),
        String(r.totalCacheReadTokens),
        String(r.totalCacheWriteTokens),
        r.totalEstimatedCostUsd.toFixed(6),
        r.sonarqubeScanDurationMs != null ? String(r.sonarqubeScanDurationMs) : "",
        r.dockerBuildDurationMs != null ? String(r.dockerBuildDurationMs) : "",
        r.promptVersion,
        r.modelVersion,
        r.rubricVersion,
      ].map(csvCell);
      lines.push(cells.join(","));
    }
    const body = `${lines.join("\n")}\n`;
    return reply
      .type("text/csv")
      .header(
        "content-disposition",
        `attachment; filename="kiln-usage-${range.fromKey}_${range.toKey}.csv"`,
      )
      .send(body);
  });
}

function csvCell(value: string): string {
  if (value === "") return "";
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
