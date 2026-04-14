import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDuration, formatPercent, formatTokens, formatUsd } from "../../src/lib/format.js";

/**
 * `kiln admin usage` — flag-routed analytics command tests.
 *
 * Plan ref: Phase 7 §3 + §4.
 *
 * The KilnApiClient is mocked so tests are hermetic. We assert on:
 *  - human-readable output for each flag mode
 *  - --ci JSON output
 *  - --export writing to --output
 *  - format helpers (formatUsd, formatTokens, formatDuration, formatPercent)
 */

// ---- mock the API client at module level --------------------------------

const fakeSummary = {
  from: "2026-04-01",
  to: "2026-04-30",
  totalSpend: 1234.5678,
  runsByType: { grading: 12, checkpoint: 7 },
  spendByModel: { "claude-sonnet-4-6": 800.0, "claude-opus-4-6": 434.5678 },
  cacheHitRate: 0.523,
  topCohorts: [
    { cohortId: "c1", name: "cohort-A", spend: 1000, runs: 14 },
    { cohortId: "c2", name: "cohort-B", spend: 234.5678, runs: 5 },
  ],
};

const fakeCohort = {
  cohortId: "c1",
  from: "2026-04-01",
  to: "2026-04-30",
  totalSpend: 100.5,
  runs: 12,
  dailySpendCurve: [{ date: "2026-04-12", cost: 100.5 }],
  perWeekTotals: [{ weekNumber: 1, cost: 100.5 }],
  pipelineSplit: { grading: 90.5, checkpoint: 10.0 },
};

const fakeStudents = [
  { userId: "u1", name: "Stu One", totalCost: 50.5, totalRuns: 5, avgDurationMs: 30_000 },
  { userId: "u2", name: "Stu Two", totalCost: 10.25, totalRuns: 2, avgDurationMs: 45_000 },
];

const fakeWeek = {
  cohortId: "c1",
  weekNumber: 1,
  passBreakdown: {
    pass1: { calls: 0, cost: 0 },
    pass2: { calls: 1, cost: 0.05 },
    pass3: { calls: 1, cost: 0.4 },
    codeAnalysis: { calls: 1, cost: 0.1 },
    other: { calls: 0, cost: 0 },
  },
  sonarqubeScanMs: 2500,
  dockerBuildMs: 12_000,
  cacheEfficiency: 0.42,
  failureRate: 0.0,
  runs: 1,
};

const fakeAlerts = [
  {
    id: "a1",
    cohortId: "c1",
    alertType: "cache_hit_rate_low",
    severity: "warning",
    title: "Cache hit rate dropped below 40%",
    detail: '{"date":"2026-04-12"}',
    acknowledgedAt: null,
    createdAt: "2026-04-13T01:00:00Z",
  },
];

const fakeForecast = {
  cohortId: "c1",
  rolling7dAvgUsd: 12.5,
  projectedMonthEndUsd: 250.0,
  currentMonthSpend: 100.0,
  daysRemaining: 12,
};

const fakeCsv =
  "event_id,cohort_id,week_id,user_id,submission_id,pipeline_type,started_at,completed_at,status,duration_ms,total_input_tokens,total_output_tokens,total_cache_read_tokens,total_cache_write_tokens,total_estimated_cost_usd,sonarqube_scan_ms,docker_build_ms,prompt_version,model_version,rubric_version\nE1,C1,W1,U1,S1,grading,2026-04-12T01:00:00.000Z,2026-04-12T01:00:30.000Z,graded,30000,1000,500,200,0,0.420000,1000,2000,pv,mv,rv\n";

vi.mock("../../src/lib/kiln-api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/kiln-api.js")>(
      "../../src/lib/kiln-api.js",
    );
  return {
    ...actual,
    KilnApiClient: class {
      async getUsageSummary() {
        return fakeSummary;
      }
      async getCohortUsage() {
        return fakeCohort;
      }
      async getCohortStudents() {
        return fakeStudents;
      }
      async getWeekDrilldown() {
        return fakeWeek;
      }
      async getAlerts() {
        return fakeAlerts;
      }
      async acknowledgeAlert() {
        return fakeAlerts[0];
      }
      async getForecast() {
        return fakeForecast;
      }
      async exportUsage() {
        return fakeCsv;
      }
    },
  };
});

const usageModulePath = resolve(__dirname, "..", "..", "src", "commands", "admin", "usage.ts");

describe("formatters", () => {
  it("formatUsd renders 4 decimals + commas", () => {
    expect(formatUsd(1234.56789)).toBe("$1,234.5679");
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(-1.5)).toBe("-$1.5000");
  });

  it("formatTokens uses K/M/B suffixes", () => {
    expect(formatTokens(123)).toBe("123");
    expect(formatTokens(1234)).toBe("1.2K");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(1_234_567_890)).toBe("1.2B");
  });

  it("formatDuration switches between ms/s/m units", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(75_000)).toBe("1m15s");
  });

  it("formatPercent renders 1-decimal percent", () => {
    expect(formatPercent(0.4123)).toBe("41.2%");
    expect(formatPercent(0)).toBe("0.0%");
  });
});

describe("kiln admin usage", () => {
  let logs: string[];
  let origLog: typeof console.log;
  let configDir: string;

  beforeEach(async () => {
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    configDir = join(tmpdir(), `kiln-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(configDir, { recursive: true });
    process.env.HOME = configDir;
    // Avoid touching the real config — point KILN_API_URL somewhere bogus
    // (the API client is mocked, so no requests actually fire).
    process.env.KILN_API_URL = "http://localhost:0";
  });

  afterEach(async () => {
    console.log = origLog;
    await rm(configDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, "KILN_API_URL");
  });

  async function runUsage(argv: string[]): Promise<void> {
    const { default: AdminUsage } = await import(usageModulePath);
    await AdminUsage.run(argv);
  }

  it("default mode prints global summary with totals + cache hit rate", async () => {
    await runUsage([]);
    const out = logs.join("\n");
    expect(out).toContain("Kiln usage summary");
    expect(out).toContain("$1,234.5678");
    expect(out).toContain("52.3%"); // cache hit rate
    expect(out).toContain("cohort-A");
  });

  it("--ci emits JSON and nothing else for summary", async () => {
    await runUsage(["--ci"]);
    const last = logs[logs.length - 1] ?? "";
    const parsed = JSON.parse(last) as { totalSpend: number };
    expect(parsed.totalSpend).toBe(1234.5678);
  });

  it("--cohort prints cohort breakdown with pipeline split", async () => {
    await runUsage(["--cohort", "c1"]);
    const out = logs.join("\n");
    expect(out).toContain("Cohort c1");
    expect(out).toContain("$100.5000");
    expect(out).toContain("grading");
    expect(out).toContain("$90.5000");
  });

  it("--students --cohort prints sorted leaderboard", async () => {
    await runUsage(["--students", "--cohort", "c1"]);
    const out = logs.join("\n");
    expect(out).toContain("Stu One");
    expect(out).toContain("$50.5000");
    expect(out).toContain("30.0s"); // 30000ms duration
  });

  it("--cohort --week renders pass-level breakdown", async () => {
    await runUsage(["--cohort", "c1", "--week", "1"]);
    const out = logs.join("\n");
    expect(out).toContain("week 1");
    expect(out).toContain("pass3");
    expect(out).toContain("$0.4000");
    expect(out).toContain("42.0%"); // cache eff
  });

  it("--alerts lists active alerts", async () => {
    await runUsage(["--alerts"]);
    const out = logs.join("\n");
    expect(out).toContain("warning");
    expect(out).toContain("cache_hit_rate_low");
  });

  it("--forecast prints rolling avg + projection", async () => {
    await runUsage(["--forecast"]);
    const out = logs.join("\n");
    expect(out).toContain("$12.5000");
    expect(out).toContain("$250.0000");
    expect(out).toContain("Days remaining:    12");
  });

  it("--export --output writes CSV to file", async () => {
    const outPath = join(configDir, "usage.csv");
    await runUsage(["--export", "--from", "2026-04-01", "--to", "2026-04-12", "--output", outPath]);
    const file = await readFile(outPath, "utf8");
    expect(file).toContain("event_id,cohort_id");
    expect(file).toContain("0.420000");
    const out = logs.join("\n");
    expect(out).toContain("Wrote");
    expect(out).toContain("usage.csv");
  });

  it("--export without --output writes CSV to stdout", async () => {
    await runUsage(["--export"]);
    const out = logs.join("\n");
    expect(out).toContain("event_id,cohort_id");
    expect(out).toContain("0.420000");
  });

  it("--students without --cohort errors out", async () => {
    await expect(runUsage(["--students"])).rejects.toThrow();
  });
});
