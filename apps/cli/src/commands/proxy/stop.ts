import { spawn } from "node:child_process";
import * as prompts from "@clack/prompts";
import { Command, Flags } from "@oclif/core";
import { KilnError, formatKilnError, isKilnError } from "../../lib/errors.js";

/**
 * `kiln proxy stop` — `docker compose stop kiln-proxy`. Leaves the container
 * in stopped state (volumes intact); use `kiln proxy start` to resume.
 */
export default class ProxyStop extends Command {
  static override description = "Stop the kiln reverse proxy";

  static override flags = {
    ci: Flags.boolean({ description: "Machine-readable output" }),
    verbose: Flags.boolean({ description: "Verbose logging" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ProxyStop);
    try {
      if (!flags.ci) prompts.intro("kiln proxy stop");
      const spin = flags.ci ? null : prompts.spinner();
      spin?.start("docker compose stop kiln-proxy");
      await new Promise<void>((resolve, reject) => {
        const p = spawn("docker", ["compose", "stop", "kiln-proxy"], {
          stdio: flags.verbose ? "inherit" : "ignore",
        });
        p.once("error", reject);
        p.once("exit", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new KilnError(`docker compose stop exited with code ${code ?? "unknown"}`, {
                code: "DOCKER_FAILED",
                fix: "Make sure Docker is running: `docker info`. Then retry with `--verbose`.",
              }),
            );
        });
      });
      spin?.stop("stopped");
      if (flags.ci) this.log(JSON.stringify({ ok: true }));
      else prompts.outro("proxy stopped");
    } catch (err) {
      if (isKilnError(err)) {
        if (flags.ci) {
          this.log(JSON.stringify({ ok: false, error: err.message, fix: err.fix, code: err.code }));
        } else {
          prompts.log.error(formatKilnError(err));
        }
        this.exit(1);
      }
      throw err;
    }
  }
}
