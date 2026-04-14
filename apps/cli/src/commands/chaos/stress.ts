import { Command, Flags } from "@oclif/core";
import { Pumba } from "../../lib/chaos/pumba.js";
import {
  buildChaosResult,
  makeExperimentId,
  writeChaosResultFile,
} from "../../lib/chaos/result-writer.js";
import { formatKilnError, isKilnError } from "../../lib/errors.js";

export default class ChaosStress extends Command {
  static override description = "Stress-test a container's CPU via Pumba stress-ng.";

  static override examples = [
    "$ kiln chaos stress --target app --cpu 4 --duration 30",
    "$ kiln chaos stress --target app --cpu 2 --duration 60 --ci",
  ];

  static override flags = {
    target: Flags.string({ description: "Container name", required: true }),
    cpu: Flags.integer({ description: "Number of CPU workers", required: true }),
    duration: Flags.integer({
      description: "Duration in seconds",
      required: true,
    }),
    ci: Flags.boolean({ description: "Machine-readable JSON output" }),
    verbose: Flags.boolean({ description: "Verbose logging" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ChaosStress);
    const cwd = process.cwd();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      const pumba = new Pumba();
      if (flags.verbose)
        this.log(
          `[stress] pumba stress --duration ${flags.duration}s --cpu ${flags.cpu} ${flags.target}`,
        );
      await pumba.stressContainer(flags.target, flags.cpu, flags.duration);

      const result = buildChaosResult({
        experimentId: makeExperimentId("stress"),
        fault: {
          kind: "rate_limit",
          target: flags.target,
          parameters: { cpu: flags.cpu, duration_seconds: flags.duration },
        },
        startedAt,
        durationMs: Date.now() - startMs,
      });

      const resultPath = await writeChaosResultFile(cwd, result);
      if (flags.ci) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        this.log(`[stress] ${flags.target} stressed  (result → ${resultPath})`);
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
