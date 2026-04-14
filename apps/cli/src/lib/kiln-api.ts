/**
 * Tiny fetch wrapper for the Kiln API.
 *
 * Phase 7 added the admin usage analytics methods at the bottom of this
 * file. Those routes require an admin JWT (KILN_ADMIN_TOKEN env var or the
 * stored auth-token in `~/.kiln/config.json`).
 *
 * Phase 8: every fetch failure surfaces a `KilnError` with a `fix` hint
 * so command catch-handlers can render it uniformly. No raw `new Error`
 * paths remain — see `apps/cli/src/lib/errors.ts`.
 */

import { KilnError } from "./errors.js";

export interface MeResponse {
  cohortId: string;
  cohortName: string;
  currentWeek: number;
  studentName?: string;
}

export interface WeekConfigResponse {
  week: number;
  projectKey: string;
  projectTitle: string;
  rubricYaml?: string;
}

// ---------------------------------------------------------------------------
// Admin usage analytics — Phase 7 §3 client surface.
// ---------------------------------------------------------------------------

export interface UsageDateRange {
  from?: string;
  to?: string;
}

export interface UsageSummary {
  from: string;
  to: string;
  totalSpend: number;
  runsByType: Record<string, number>;
  spendByModel: Record<string, number>;
  cacheHitRate: number;
  topCohorts: Array<{ cohortId: string; name: string; spend: number; runs: number }>;
  pricingWarning?: string;
}

export interface CohortUsage {
  cohortId: string;
  from: string;
  to: string;
  totalSpend: number;
  runs: number;
  dailySpendCurve: Array<{ date: string; cost: number }>;
  perWeekTotals: Array<{ weekNumber: number; cost: number }>;
  pipelineSplit: { grading: number; checkpoint: number };
  pricingWarning?: string;
}

export interface CohortStudent {
  userId: string;
  name: string;
  totalCost: number;
  totalRuns: number;
  avgDurationMs: number;
}

export interface WeekDrilldown {
  cohortId: string;
  weekNumber: number;
  passBreakdown: Record<string, { calls: number; cost: number }>;
  sonarqubeScanMs: number;
  dockerBuildMs: number;
  cacheEfficiency: number;
  failureRate: number;
  runs: number;
}

export interface UsageAlert {
  id: string;
  cohortId: string | null;
  alertType: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  acknowledgedAt: string | null;
  createdAt: string | null;
}

export interface UsageForecast {
  cohortId: string | null;
  rolling7dAvgUsd: number;
  projectedMonthEndUsd: number;
  currentMonthSpend: number;
  daysRemaining: number;
  pricingWarning?: string;
}

export const MOCK_ME: MeResponse = {
  cohortId: "cohort-dev",
  cohortName: "dev-local",
  currentWeek: 1,
};

export const MOCK_WEEK_CONFIG: WeekConfigResponse = {
  week: 1,
  projectKey: "week-01-local",
  projectTitle: "Local Development Week 1",
  rubricYaml: "# Mock rubric — Phase 5 API will replace this\ncriteria: []\n",
};

export class KilnApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authToken?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.authToken) h.authorization = `Bearer ${this.authToken}`;
    return h;
  }

  async login(email: string, password: string): Promise<{ token: string }> {
    // DEFERRED: Phase 5 API
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw new KilnError(`Login failed: ${res.status}`, {
        code: "api_login_failed",
        fix: "Check your email/password and that the Kiln API is reachable.",
      });
    }
    return (await res.json()) as { token: string };
  }

  async me(): Promise<MeResponse> {
    // DEFERRED: Phase 5 API
    const res = await fetch(`${this.baseUrl}/api/me`, { headers: this.headers() });
    if (!res.ok) {
      throw new KilnError(`/api/me failed: ${res.status}`, {
        code: "api_me_failed",
        fix: "Your JWT may be missing or expired. Run `kiln init` to refresh it.",
      });
    }
    return (await res.json()) as MeResponse;
  }

  async weekConfig(cohortId: string, week: number): Promise<WeekConfigResponse> {
    // DEFERRED: Phase 5 API
    const res = await fetch(
      `${this.baseUrl}/api/cohorts/${encodeURIComponent(cohortId)}/weeks/${week}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new KilnError(`week config failed: ${res.status}`, {
        code: "api_week_config_failed",
        fix: "Confirm the cohort has a week record for this number. Ask your cohort admin to run `kiln admin weeks create`.",
      });
    }
    return (await res.json()) as WeekConfigResponse;
  }

  // -------------------------------------------------------------------------
  // Admin usage routes — Phase 7
  // -------------------------------------------------------------------------

  private buildQuery(params: Record<string, string | undefined>): string {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") u.set(k, v);
    }
    const s = u.toString();
    return s ? `?${s}` : "";
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text();
      throw new KilnError(`GET ${path} failed: ${res.status} ${text}`, {
        code: "api_get_failed",
        fix: "Verify your admin JWT (KILN_ADMIN_TOKEN) and that the Kiln API is reachable. Run `kiln doctor`.",
      });
    }
    return (await res.json()) as T;
  }

  async getUsageSummary(opts: UsageDateRange = {}): Promise<UsageSummary> {
    return this.getJson<UsageSummary>(
      `/api/admin/usage/summary${this.buildQuery({ from: opts.from, to: opts.to })}`,
    );
  }

  async getCohortUsage(
    cohortId: string,
    opts: UsageDateRange & { week?: number } = {},
  ): Promise<CohortUsage> {
    return this.getJson<CohortUsage>(
      `/api/admin/usage/cohorts/${encodeURIComponent(cohortId)}${this.buildQuery({
        from: opts.from,
        to: opts.to,
        week: opts.week !== undefined ? String(opts.week) : undefined,
      })}`,
    );
  }

  async getCohortStudents(cohortId: string): Promise<CohortStudent[]> {
    return this.getJson<CohortStudent[]>(
      `/api/admin/usage/cohorts/${encodeURIComponent(cohortId)}/students`,
    );
  }

  async getWeekDrilldown(cohortId: string, week: number): Promise<WeekDrilldown> {
    return this.getJson<WeekDrilldown>(
      `/api/admin/usage/cohorts/${encodeURIComponent(cohortId)}/weeks/${week}`,
    );
  }

  async getAlerts(opts: { severity?: string; cohort?: string } = {}): Promise<UsageAlert[]> {
    return this.getJson<UsageAlert[]>(
      `/api/admin/usage/alerts${this.buildQuery({
        severity: opts.severity,
        cohort_id: opts.cohort,
      })}`,
    );
  }

  async acknowledgeAlert(id: string): Promise<UsageAlert> {
    const res = await fetch(`${this.baseUrl}/api/admin/usage/alerts/${id}/acknowledge`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new KilnError(`acknowledgeAlert failed: ${res.status}`, {
        code: "api_ack_alert_failed",
        fix: "Confirm the alert id exists and your admin JWT is valid.",
      });
    }
    return (await res.json()) as UsageAlert;
  }

  async getForecast(opts: { cohort?: string } = {}): Promise<UsageForecast> {
    return this.getJson<UsageForecast>(
      `/api/admin/usage/forecast${this.buildQuery({ cohort_id: opts.cohort })}`,
    );
  }

  async exportUsage(opts: { from?: string; to?: string; cohort?: string } = {}): Promise<string> {
    const q = this.buildQuery({ from: opts.from, to: opts.to, cohort_id: opts.cohort });
    const res = await fetch(`${this.baseUrl}/api/admin/usage/export${q}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new KilnError(`exportUsage failed: ${res.status}`, {
        code: "api_export_failed",
        fix: "Retry with a smaller date range, or check that the API is running.",
      });
    }
    return await res.text();
  }

  async pingWithTimeout(timeoutMs = 1500): Promise<boolean> {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(`${this.baseUrl}/api/health`, {
        signal: ac.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }
}
