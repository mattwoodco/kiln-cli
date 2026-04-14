import { Command, Flags } from "@oclif/core";
import {
  buildChaosResult,
  makeExperimentId,
  writeChaosResultFile,
} from "../../lib/chaos/result-writer.js";
import { ToxiproxyClient } from "../../lib/chaos/toxiproxy.js";
import { formatKilnError, isKilnError } from "../../lib/errors.js";

export default class ChaosDisconnect extends Command {
  static override description =
    "Disconnect a Toxiproxy upstream for a fixed duration, then reconnect.";

  static override examples = [
    "$ kiln chaos disconnect --target api --duration 10",
    "$ kiln chaos disconnect --target api --duration 30 --ci",
  ];

  static override flags = {
    target: Flags.string({ description: "Toxiproxy proxy name", required: true }),
    duration: Flags.integer({
      description: "Duration of the disconnect in seconds",
      required: true,
    }),
    ci: Flags.boolean({ description: "Machine-readable JSON output" }),
    verbose: Flags.boolean({ description: "Verbose logging" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ChaosDisconnect);
    const cwd = process.cwd();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      const client = new ToxiproxyClient();
      if (flags.verbose)
        this.log(`[disconnect] ${flags.target} for ${flags.duration}s via ${client.baseUrl}`);
      await client.addDisconnect(flags.target, flags.duration);

      const result = buildChaosResult({
        experimentId: makeExperimentId("disconnect"),
        fault: {
          kind: "disconnect",
          target: flags.target,
          parameters: { duration_seconds: flags.duration },
        },
        startedAt,
        durationMs: Date.now() - startMs,
      });

      const resultPath = await writeChaosResultFile(cwd, result);
      if (flags.ci) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        this.log(`[disconnect] ${flags.target} reconnected  (result → ${resultPath})`);
      }
    } catch (err) {
      if (isKilnError(err)) {
        if (flags.ci) {
          this.log(JSON.stringify({ ok: false, error: err.message, fix: err.fix, code: err.code }));
        } else {
          this.log(formatKilnError(err));
        }
        this.exit(1);
      }
      throw err;
    }
  }
}
