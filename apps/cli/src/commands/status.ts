import { Args, Command } from "@oclif/core";
import { ConfigStore } from "../lib/config-store.js";

/**
 * kiln status <jobId> — poll the API for Temporal workflow progress.
 */
export default class Status extends Command {
  static override description = "Show grading pipeline progress for a submission job.";

  static override args = {
    jobId: Args.string({
      description: "Job/workflow id returned by `kiln submit`.",
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Status);
    const store = new ConfigStore();
    const config = await store.read();
    const apiUrl = config.apiUrl ?? process.env.KILN_API_URL ?? "http://localhost:4000";
    const token = config.authToken ?? process.env.KILN_TOKEN ?? "";

    const res = await fetch(`${apiUrl}/api/status/${args.jobId}`, {
      headers: { authorization: token ? `Bearer ${token}` : "" },
    });
    if (!res.ok) {
      this.error(`status_failed: ${res.status} ${await res.text()}`);
    }
    const payload = (await res.json()) as { status: string; runId?: string };
    this.log(`job=${args.jobId} status=${payload.status} runId=${payload.runId ?? "-"}`);
  }
}
