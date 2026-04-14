import { spawn } from "node:child_process";
import * as prompts from "@clack/prompts";
import { Command, Flags } from "@oclif/core";
import { KilnError, formatKilnError, isKilnError } from "../../lib/errors.js";

/**
 * `kiln proxy start` — bring up the kiln-proxy container via docker compose
 * and poll :9100/healthz until the proxy is serving (or we time out at 10s).
 *
 * Assumes `docker-compose.yml` (or `infra/docker-compose.infra.yml`) defines a
 * service named `kiln-proxy`. The compose file itself lands in a later phase;
 * this command is the CLI surface.
 */
export default class ProxyStart extends Command {
  static override description = "Start the kiln reverse proxy via docker compose";

  static override flags = {
    ci: Flags.boolean({ description: "Emit machine-readable output; no spinners" }),
    verbose: Flags.boolean({ description: "Verbose logging" }),
    timeout: Flags.integer({
      description: "Health-poll timeout in seconds",
      default: 10,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ProxyStart);
    try {
      if (!flags.ci) prompts.intro("kiln proxy start");

      const spin = flags.ci ? null : prompts.spinner();
      spin?.start("docker compose up -d kiln-proxy");
      await runCommand("docker", ["compose", "up", "-d", "kiln-proxy"], flags.verbose);
      spin?.stop("container up");

      const spin2 = flags.ci ? null : prompts.spinner();
      spin2?.start("waiting for /healthz");
      const healthy = await waitForHealth("http://localhost:9100/healthz", flags.timeout * 1000);
      if (!healthy) {
        throw new KilnError("kiln-proxy did not become healthy in time", {
          code: "PROXY_UNHEALTHY",
          fix: "Check `docker logs kiln-proxy` for errors, then `kiln proxy start --verbose`.",
        });
      }
      spin2?.stop("healthy");

      const status = await fetchStatusTable();
      if (flags.ci) {
        this.log(JSON.stringify({ ok: true, ports: status }, null, 2));
      } else {
        prompts.note(
          status.map((s) => `  :${s.port} ${s.upstream} → ${s.status}`).join("\n"),
          "proxy status",
        );
        prompts.outro("ready");
      }
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

async function runCommand(cmd: string, args: string[], verbose: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: verbose ? "inherit" : "ignore" });
    p.once("error", reject);
    p.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new KilnError(`${cmd} ${args.join(" ")} exited with code ${code ?? "unknown"}`, {
            code: "DOCKER_FAILED",
            fix: "Make sure Docker is running: `docker info`. Then retry with `--verbose`.",
          }),
        );
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return true;
    } catch {
      // ignore
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  return false;
}

type StatusRow = { port: number; upstream: string; status: string; interactions: number };

async function fetchStatusTable(): Promise<StatusRow[]> {
  const ports: Array<{ port: number; upstream: string }> = [
    { port: 9100, upstream: "anthropic" },
    { port: 9101, upstream: "openai" },
    { port: 9102, upstream: "google" },
  ];
  return Promise.all(
    ports.map(async ({ port, upstream }): Promise<StatusRow> => {
      try {
        const res = await fetch(`http://localhost:${port}/healthz`);
        if (!res.ok) return { port, upstream, status: `http ${res.status}`, interactions: 0 };
        const body = (await res.json()) as { status?: string; interactions?: number };
        return {
          port,
          upstream,
          status: body.status ?? "unknown",
          interactions: body.interactions ?? 0,
        };
      } catch {
        return { port, upstream, status: "unreachable", interactions: 0 };
      }
    }),
  );
}
