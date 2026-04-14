/**
 * `kiln admin dispatch test <targetId>` — synthetic dispatch test.
 *
 * Phase 7.5 §8. NO HTTP POST is performed; the API returns a preview
 * payload so admins can sanity-check the shape before enabling.
 */

import { Args, Command, Flags } from "@oclif/core";
import { ConfigStore } from "../../../lib/config-store.js";

interface TestResponse {
  httpStatus: number;
  latencyMs: number;
  previewPayload: Record<string, unknown>;
  note?: string;
}

export default class DispatchTest extends Command {
  static override description = "Run a synthetic test for a dispatch target (no DB writes).";

  static override args = {
    targetId: Args.string({ description: "Dispatch target UUID.", required: true }),
  };

  static override flags = {
    ci: Flags.boolean({ description: "JSON output for CI.", default: false }),
    verbose: Flags.boolean({ description: "Print full preview payload.", default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DispatchTest);
    const store = new ConfigStore();
    const config = await store.read();
    const apiUrl = config.apiUrl ?? process.env.KILN_API_URL ?? "http://localhost:4000";
    const token = config.authToken ?? process.env.KILN_TOKEN ?? "";

    const res = await fetch(`${apiUrl}/api/admin/dispatch/targets/${args.targetId}/test`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: token ? `Bearer ${token}` : "",
      },
    });
    if (!res.ok) {
      this.error(`dispatch_test_failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as TestResponse;

    if (flags.ci) {
      this.log(JSON.stringify(body, null, 2));
      return;
    }

    this.log(`target ${args.targetId}: synthetic test`);
    if (body.note) this.log(`  note: ${body.note}`);
    if (flags.verbose) {
      this.log("  preview payload:");
      this.log(JSON.stringify(body.previewPayload, null, 2));
    } else {
      const keys = Object.keys(body.previewPayload).join(", ");
      this.log(`  payload keys: ${keys}`);
    }
  }
}
