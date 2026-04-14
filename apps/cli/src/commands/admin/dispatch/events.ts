/**
 * `kiln admin dispatch events --cohort <id> [--status dead_letter]`
 *
 * Phase 7.5 §8. Observability drilldown. Filterable by cohort, target,
 * submission, and status.
 */

import { Command, Flags } from "@oclif/core";
import { ConfigStore } from "../../../lib/config-store.js";

interface EventRow {
  id: string;
  targetId: string;
  submissionId: string;
  cohortId: string;
  attempt: number;
  status: string;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
  payloadBytes: number;
  responseRef: string | null;
  createdAt: string | null;
}

export default class DispatchEvents extends Command {
  static override description = "List dispatch events with optional filters.";

  static override flags = {
    cohort: Flags.string({ description: "Cohort UUID (required).", required: true }),
    target: Flags.string({ description: "Filter by target UUID." }),
    submission: Flags.string({ description: "Filter by submission UUID." }),
    status: Flags.string({
      description: "Filter by status",
      options: ["pending", "success", "retrying", "failed", "dead_letter"],
    }),
    limit: Flags.integer({ description: "Max rows.", default: 50 }),
    ci: Flags.boolean({ description: "JSON output for CI.", default: false }),
    verbose: Flags.boolean({ description: "Include error column.", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DispatchEvents);
    const store = new ConfigStore();
    const config = await store.read();
    const apiUrl = config.apiUrl ?? process.env.KILN_API_URL ?? "http://localhost:4000";
    const token = config.authToken ?? process.env.KILN_TOKEN ?? "";

    const url = new URL(`${apiUrl}/api/admin/dispatch/events`);
    url.searchParams.set("cohort_id", flags.cohort);
    if (flags.target) url.searchParams.set("target_id", flags.target);
    if (flags.submission) url.searchParams.set("submission_id", flags.submission);
    if (flags.status) url.searchParams.set("status", flags.status);
    url.searchParams.set("limit", String(flags.limit));

    const res = await fetch(url.toString(), {
      headers: { authorization: token ? `Bearer ${token}` : "" },
    });
    if (!res.ok) {
      this.error(`dispatch_events_failed: ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as EventRow[];

    if (flags.ci) {
      this.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (rows.length === 0) {
      this.log("(no dispatch events match these filters)");
      return;
    }

    for (const r of rows) {
      const status = r.status.padEnd(11);
      const http = r.httpStatus ?? "-";
      const latency = r.latencyMs !== null ? `${r.latencyMs}ms` : "-";
      this.log(
        `${(r.createdAt ?? "").slice(0, 19)} ${status} attempt=${r.attempt} http=${http} ${latency} target=${r.targetId.slice(0, 8)} sub=${r.submissionId.slice(0, 8)}`,
      );
      if (flags.verbose && r.error) {
        this.log(`  error: ${r.error}`);
      }
    }
  }
}
