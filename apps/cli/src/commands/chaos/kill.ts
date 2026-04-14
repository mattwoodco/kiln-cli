import { Command, Flags } from "@oclif/core";
import { Pumba } from "../../lib/chaos/pumba.js";
import {
  buildChaosResult,
  makeExperimentId,
  writeChaosResultFile,
} from "../../lib/chaos/result-writer.js";
import { formatKilnError, isKilnError } from "../../lib/errors.js";

export default class ChaosKill extends Command {
  static override description = "Kill a Docker container via Pumba after an optional delay.";

  static override examples = [
    "$ kiln chaos kill --target app",
    "$ kiln chaos kill --target app --in 5 --ci",
  ];

  static override flags = {
    target: Flags.string({ description: "Container name", required: true }),
    in: Flags.integer({
      description: "Seconds to wait before killing (default 0)",
      default: 0,
    }),
    ci: Flags.boolean({ description: "Machine-readable JSON output" }),
    verbose: Flags.boolean({ description: "Verbose logging" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ChaosKill);
    const cwd = process.cwd();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      const pumba = new Pumba();
      if (flags.verbose) this.log(`[kill] pumba kill --interval ${flags.in}s ${flags.target}`);
      await pumba.killContainer(flags.target, { inSeconds: flags.in });

      const result = buildChaosResult({
        experimentId: makeExperimentId("kill"),
        fault: {
          kind: "drop",
          target: flags.target,
          parameters: { in_seconds: flags.in, signal: "SIGKILL" },
        },
        startedAt,
        durationMs: Date.now() - startMs,
      });

      const resultPath = await writeChaosResultFile(cwd, result);
      if (flags.ci) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        this.log(`[kill] ${flags.target} killed  (result → ${resultPath})`);
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
