import { Command, Flags } from "@oclif/core";
import {
  buildChaosResult,
  makeExperimentId,
  writeChaosResultFile,
} from "../../lib/chaos/result-writer.js";
import { runSteadyState } from "../../lib/chaos/steady-state.js";
import { ToxiproxyClient } from "../../lib/chaos/toxiproxy.js";
import { formatKilnError, isKilnError } from "../../lib/errors.js";

export default class ChaosLatency extends Command {
  static override description =
    "Inject latency via Toxiproxy into a named proxy, optionally verifying steady state.";

  static override examples = [
    "$ kiln chaos latency --target api --delay 500 --duration 30 --verify",
    "$ kiln chaos latency --target api --delay 1000 --jitter 250 --duration 60 --ci",
  ];

  static override flags = {
    target: Flags.string({ description: "Toxiproxy proxy name", required: true }),
    delay: Flags.integer({ description: "Latency to add (ms)", required: true }),
    jitter: Flags.integer({ description: "Jitter (ms)", default: 0 }),
    duration: Flags.integer({
      description: "How long to hold the latency (seconds)",
      required: true,
    }),
    verify: Flags.boolean({
      description: "Run steady-state before and after.",
      default: false,
    }),
    ci: Flags.boolean({ description: "Machine-readable JSON output" }),
    verbose: Flags.boolean({ description: "Verbose logging" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ChaosLatency);
    const cwd = process.cwd();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      const client = new ToxiproxyClient();
      if (flags.verbose) this.log(`[latency] using toxiproxy at ${client.baseUrl}`);

      const pre = flags.verify ? await runSteadyState({ projectDir: cwd }) : null;
      if (flags.verbose && pre) this.log(`[latency] steady-state pre: ${pre.verdict}`);

      await client.addLatency(flags.target, flags.delay, flags.jitter);
      if (flags.verbose)
        this.log(
          `[latency] injected ${flags.delay}ms (+/- ${flags.jitter}ms) on ${flags.target}; holding ${flags.duration}s`,
        );

      await new Promise<void>((r) => setTimeout(r, flags.duration * 1000));
      await client.removeAll();
      if (flags.verbose) this.log("[latency] removed all toxics");

      const post = flags.verify ? await runSteadyState({ projectDir: cwd }) : null;
      if (flags.verbose && post) this.log(`[latency] steady-state post: ${post.verdict}`);

      const result = buildChaosResult({
        experimentId: makeExperimentId("latency"),
        fault: {
          kind: "latency",
          target: flags.target,
          parameters: {
            delay_ms: flags.delay,
            jitter_ms: flags.jitter,
            duration_seconds: flags.duration,
          },
        },
        startedAt,
        durationMs: Date.now() - startMs,
        pre,
        post,
        observations: [],
      });

      const resultPath = await writeChaosResultFile(cwd, result);
      if (flags.ci) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        this.log(`[latency] verdict: ${result.verdict}  (result → ${resultPath})`);
      }
      if (result.verdict === "FAIL") this.exit(1);
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
