import { writeFile } from "node:fs/promises";
import { Command, Flags } from "@oclif/core";
import { ConfigStore } from "../../lib/config-store.js";
import { formatDuration, formatPercent, formatTokens, formatUsd } from "../../lib/format.js";
import {
  type CohortStudent,
  type CohortUsage,
  KilnApiClient,
  type UsageAlert,
  type UsageForecast,
  type UsageSummary,
  type WeekDrilldown,
} from "../../lib/kiln-api.js";

/**
 * `kiln admin usage` — cost + usage analytics.
 *
 * Plan ref: Phase 7 §3 (lines 1094-1107).
 *
 * Flag-routed (no subcommands). The flag combinations map to:
 *   default                       → global summary
 *   --cohort <id>                 → per-cohort
 *   --cohort <id> --week <n>      → per-week drilldown
 *   --students --cohort <id>      → per-student leaderboard
 *   --forecast                    → spend projection
 *   --alerts                      → active alerts
 *   --export --from <d> --to <d>  → CSV export to --output (or stdout)
 */
export default class AdminUsage extends Command {
  static override description = "Cost + usage analytics for the Kiln pipeline.";

  static override flags = {
    cohort: Flags.string({ description: "Cohort id (uuid) to scope the query to" }),
    week: Flags.integer({ description: "Week number (requires --cohort)" }),
    students: Flags.boolean({
      description: "Show per-student leaderboard for --cohort",
      default: false,
    }),
    forecast: Flags.boolean({ description: "Show rolling 7-day avg + month-end projection" }),
    alerts: Flags.boolean({ description: "List active (unacknowledged) alerts" }),
    severity: Flags.string({
      description: "Filter alerts by severity (info|warning|critical)",
    }),
    export: Flags.boolean({ description: "Export raw events as CSV" }),
    from: Flags.string({ description: "Start date YYYY-MM-DD (export + summary)" }),
    to: Flags.string({ description: "End date YYYY-MM-DD (export + summary)" }),
    output: Flags.string({ description: "Output file path for --export (default stdout)" }),
    ci: Flags.boolean({ description: "Machine-readable JSON output", default: false }),
    verbose: Flags.boolean({ description: "Add per-call detail rows where available" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AdminUsage);

    const store = new ConfigStore();
    const config = await store.read();
    const apiUrl = config.apiUrl ?? process.env.KILN_API_URL ?? "http://localhost:4000";
    const token = process.env.KILN_ADMIN_TOKEN ?? config.authToken ?? process.env.KILN_TOKEN ?? "";
    const client = new KilnApiClient(apiUrl, token);

    // ---- Routing ----------------------------------------------------------
    if (flags.export) {
      await this.runExport(client, flags);
      return;
    }
    if (flags.alerts) {
      await this.runAlerts(client, flags);
      return;
    }
    if (flags.forecast) {
      await this.runForecast(client, flags);
      return;
    }
    if (flags.students) {
      if (!flags.cohort) {
        this.error("--students requires --cohort <id>");
      }
      await this.runStudents(client, flags.cohort, flags);
      return;
    }
    if (flags.cohort && flags.week !== undefined) {
      await this.runWeek(client, flags.cohort, flags.week, flags);
      return;
    }
    if (flags.cohort) {
      await this.runCohort(client, flags.cohort, flags);
      return;
    }
    await this.runSummary(client, flags);
  }

  // -----------------------------------------------------------------------
  // Sub-routines, one per flag mode
  // -----------------------------------------------------------------------

  private async runSummary(
    client: KilnApiClient,
    flags: { ci: boolean; from?: string; to?: string; verbose: boolean },
  ): Promise<void> {
    const summary = await client.getUsageSummary({ from: flags.from, to: flags.to });
    if (flags.ci) {
      this.log(JSON.stringify(summary));
      return;
    }
    this.printSummary(summary);
  }

  private async runCohort(
    client: KilnApiClient,
    cohortId: string,
    flags: { ci: boolean; from?: string; to?: string },
  ): Promise<void> {
    const cohort = await client.getCohortUsage(cohortId, { from: flags.from, to: flags.to });
    if (flags.ci) {
      this.log(JSON.stringify(cohort));
      return;
    }
    this.printCohort(cohort);
  }

  private async runStudents(
    client: KilnApiClient,
    cohortId: string,
    flags: { ci: boolean },
  ): Promise<void> {
    const students = await client.getCohortStudents(cohortId);
    if (flags.ci) {
      this.log(JSON.stringify(students));
      return;
    }
    this.printStudents(students);
  }

  private async runWeek(
    client: KilnApiClient,
    cohortId: string,
    week: number,
    flags: { ci: boolean },
  ): Promise<void> {
    const drill = await client.getWeekDrilldown(cohortId, week);
    if (flags.ci) {
      this.log(JSON.stringify(drill));
      return;
    }
    this.printWeek(drill);
  }

  private async runForecast(
    client: KilnApiClient,
    flags: { ci: boolean; cohort?: string },
  ): Promise<void> {
    const forecast = await client.getForecast({ cohort: flags.cohort });
    if (flags.ci) {
      this.log(JSON.stringify(forecast));
      return;
    }
    this.printForecast(forecast);
  }

  private async runAlerts(
    client: KilnApiClient,
    flags: { ci: boolean; severity?: string; cohort?: string },
  ): Promise<void> {
    const alerts = await client.getAlerts({ severity: flags.severity, cohort: flags.cohort });
    if (flags.ci) {
      this.log(JSON.stringify(alerts));
      return;
    }
    this.printAlerts(alerts);
  }

  private async runExport(
    client: KilnApiClient,
    flags: { from?: string; to?: string; cohort?: string; output?: string },
  ): Promise<void> {
    const csv = await client.exportUsage({
      from: flags.from,
      to: flags.to,
      cohort: flags.cohort,
    });
    if (flags.output) {
      await writeFile(flags.output, csv);
      this.log(`Wrote ${csv.split("\n").length - 1} rows to ${flags.output}`);
    } else {
      this.log(csv);
    }
  }

  // -----------------------------------------------------------------------
  // Pretty printers
  // -----------------------------------------------------------------------

  private printSummary(s: UsageSummary): void {
    if (s.pricingWarning) {
      this.log(`[warn] ${s.pricingWarning}`);
    }
    this.log(`Kiln usage summary  (${s.from} → ${s.to})`);
    this.log("");
    this.log(`  Total spend:     ${formatUsd(s.totalSpend)}`);
    this.log(`  Cache hit rate:  ${formatPercent(s.cacheHitRate)}`);
    this.log("");
    this.log("  Runs by type:");
    for (const [k, v] of Object.entries(s.runsByType)) {
      this.log(`    ${k.padEnd(12)} ${v}`);
    }
    this.log("");
    this.log("  Spend by model:");
    for (const [model, cost] of Object.entries(s.spendByModel)) {
      this.log(`    ${model.padEnd(28)} ${formatUsd(cost)}`);
    }
    this.log("");
    if (s.topCohorts.length > 0) {
      this.log("  Top cohorts:");
      this.log(`    ${"name".padEnd(24)} ${"spend".padStart(14)}  ${"runs".padStart(6)}`);
      for (const c of s.topCohorts) {
        this.log(
          `    ${c.name.padEnd(24)} ${formatUsd(c.spend).padStart(14)}  ${String(c.runs).padStart(6)}`,
        );
      }
    }
  }

  private printCohort(c: CohortUsage): void {
    if (c.pricingWarning) {
      this.log(`[warn] ${c.pricingWarning}`);
    }
    this.log(`Cohort ${c.cohortId}  (${c.from} → ${c.to})`);
    this.log("");
    this.log(`  Total spend: ${formatUsd(c.totalSpend)}`);
    this.log(`  Runs:        ${c.runs}`);
    this.log("  Pipeline split:");
    this.log(`    grading    ${formatUsd(c.pipelineSplit.grading)}`);
    this.log(`    checkpoint ${formatUsd(c.pipelineSplit.checkpoint)}`);
    this.log("");
    if (c.dailySpendCurve.length > 0) {
      this.log("  Daily spend:");
      for (const d of c.dailySpendCurve) {
        this.log(`    ${d.date}  ${formatUsd(d.cost)}`);
      }
      this.log("");
    }
    if (c.perWeekTotals.length > 0) {
      this.log("  Per-week totals:");
      for (const w of c.perWeekTotals) {
        this.log(`    week ${String(w.weekNumber).padStart(2, "0")}  ${formatUsd(w.cost)}`);
      }
    }
  }

  private printStudents(rows: CohortStudent[]): void {
    if (rows.length === 0) {
      this.log("(no events)");
      return;
    }
    this.log(
      `${"student".padEnd(28)} ${"cost".padStart(14)} ${"runs".padStart(6)} ${"avg".padStart(8)}`,
    );
    for (const r of rows) {
      this.log(
        `${r.name.padEnd(28)} ${formatUsd(r.totalCost).padStart(14)} ${String(r.totalRuns).padStart(6)} ${formatDuration(r.avgDurationMs).padStart(8)}`,
      );
    }
  }

  private printWeek(d: WeekDrilldown): void {
    this.log(`Cohort ${d.cohortId} · week ${d.weekNumber}`);
    this.log("");
    this.log(`  Runs:           ${d.runs}`);
    this.log(`  Cache eff:      ${formatPercent(d.cacheEfficiency)}`);
    this.log(`  Failure rate:   ${formatPercent(d.failureRate)}`);
    this.log(`  Sonar scan p95: ${formatDuration(d.sonarqubeScanMs)}`);
    this.log(`  Docker build:   ${formatDuration(d.dockerBuildMs)}`);
    this.log("");
    this.log("  Pass-level cost:");
    for (const [bucket, info] of Object.entries(d.passBreakdown)) {
      this.log(
        `    ${bucket.padEnd(14)} calls=${String(info.calls).padStart(4)}  cost=${formatUsd(info.cost)}`,
      );
    }
  }

  private printForecast(f: UsageForecast): void {
    if (f.pricingWarning) {
      this.log(`[warn] ${f.pricingWarning}`);
    }
    this.log(`Cohort:            ${f.cohortId ?? "(all)"}`);
    this.log(`Rolling 7-day avg: ${formatUsd(f.rolling7dAvgUsd)}`);
    this.log(`Current month:     ${formatUsd(f.currentMonthSpend)}`);
    this.log(`Days remaining:    ${f.daysRemaining}`);
    this.log(`Projected EOM:     ${formatUsd(f.projectedMonthEndUsd)}`);
  }

  private printAlerts(rows: UsageAlert[]): void {
    if (rows.length === 0) {
      this.log("(no active alerts)");
      return;
    }
    this.log(`${"severity".padEnd(10)} ${"type".padEnd(28)} ${"cohort".padEnd(36)} title`);
    for (const a of rows) {
      this.log(
        `${a.severity.padEnd(10)} ${a.alertType.padEnd(28)} ${(a.cohortId ?? "-").padEnd(36)} ${a.title}`,
      );
    }
  }
}

// Token-formatter is exported so other commands (or tests) can reuse it.
export { formatTokens };
