/**
 * `kiln admin dispatch list --cohort <id>` — list dispatch targets.
 *
 * Phase 7.5 §8. Same `--ci` / `--verbose` flags as `admin usage`.
 */

import { Command, Flags } from "@oclif/core";
import { ConfigStore } from "../../../lib/config-store.js";

interface TargetRow {
  id: string;
  cohortId: string;
  weekId: string | null;
  name: string;
  url: string;
  authMode: string;
  authSecretRef: string | null;
  artifactSelectors: string[];
  triggerOn: string[];
  enabled: boolean;
}

export default class DispatchList extends Command {
  static override description = "List artifact dispatch targets for a cohort.";

  static override flags = {
    cohort: Flags.string({ description: "Cohort UUID to list targets for.", required: true }),
    week: Flags.string({ description: "Optional week UUID filter." }),
    ci: Flags.boolean({ description: "JSON output for CI.", default: false }),
    verbose: Flags.boolean({ description: "Include full URL + secret ref.", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DispatchList);
    const store = new ConfigStore();
    const config = await store.read();
    const apiUrl = config.apiUrl ?? process.env.KILN_API_URL ?? "http://localhost:4000";
    const token = config.authToken ?? process.env.KILN_TOKEN ?? "";

    const url = new URL(`${apiUrl}/api/admin/cohorts/${flags.cohort}/dispatch/targets`);
    if (flags.week) url.searchParams.set("week", flags.week);

    const res = await fetch(url.toString(), {
      headers: { authorization: token ? `Bearer ${token}` : "" },
    });
    if (!res.ok) {
      this.error(`dispatch_list_failed: ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as TargetRow[];

    if (flags.ci) {
      this.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (rows.length === 0) {
      this.log("(no dispatch targets configured for this cohort)");
      return;
    }

    for (const r of rows) {
      const enabled = r.enabled ? "ENABLED " : "DISABLED";
      const week = r.weekId ? `week=${r.weekId.slice(0, 8)}` : "cohort-wide";
      this.log(
        `${enabled} ${r.name} [${week}] auth=${r.authMode} triggers=${r.triggerOn.join(",")}`,
      );
      if (flags.verbose) {
        this.log(`  url: ${r.url}`);
        this.log(`  secret_ref: ${r.authSecretRef ?? "(none)"}`);
        this.log(`  selectors: ${r.artifactSelectors.join(", ")}`);
      }
    }
  }
}
