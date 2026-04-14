import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command, Flags } from "@oclif/core";
import { ConfigStore } from "../lib/config-store.js";
import {
  type CheckResult,
  checkBun,
  checkDocker,
  checkDockerCompose,
  checkGit,
  detectContainerRuntime,
} from "../lib/doctor-checks.js";
import { formatKilnError, isKilnError } from "../lib/errors.js";
import { KilnApiClient } from "../lib/kiln-api.js";
import { discoverRuntimes, runtimeLabel } from "../lib/runtime-discovery.js";

interface ProjectState {
  isProject: boolean;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasKilnDir: boolean;
  hasHarnessJsonl: boolean;
  hasProxyConfig: boolean;
}

function inspectProject(cwd: string): ProjectState {
  const hasDockerfile =
    existsSync(join(cwd, "Dockerfile")) || existsSync(join(cwd, "Containerfile"));
  const hasCompose =
    existsSync(join(cwd, "docker-compose.yml")) || existsSync(join(cwd, "compose.yaml"));
  const hasKilnDir = existsSync(join(cwd, ".kiln"));
  const hasHarnessJsonl = existsSync(join(cwd, ".kiln", "harness.jsonl"));
  const hasProxyConfig = existsSync(join(cwd, ".kiln", "proxy.yml"));
  const isProject = hasKilnDir || hasCompose || hasDockerfile;
  return {
    isProject,
    hasDockerfile,
    hasCompose,
    hasKilnDir,
    hasHarnessJsonl,
    hasProxyConfig,
  };
}

async function pingUrl(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return res.status < 500;
  } catch {
    return false;
  }
}

function renderCheck(c: CheckResult): string {
  const icon = c.status === "ok" ? "OK" : c.status === "warn" ? "WARN" : "FAIL";
  return `[${icon}] ${c.name}: ${c.detail}`;
}

export default class Doctor extends Command {
  static override description =
    "Run non-destructive health checks against the host, Kiln services, and the current project (if any).";

  static override examples = [
    "$ kiln doctor",
    "$ kiln doctor --verbose",
    "$ kiln doctor --project",
  ];

  static override flags = {
    verbose: Flags.boolean({ description: "Per-check details even when green." }),
    ci: Flags.boolean({ description: "Non-interactive mode." }),
    project: Flags.boolean({
      description: "Force project-directory checks (default auto-detected).",
      allowNo: true,
    }),
    "api-url": Flags.string({
      description: "Kiln API base URL.",
      default: process.env.KILN_API_URL ?? "http://localhost:4000",
      env: "KILN_API_URL",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const verbose = flags.verbose === true;
    const cwd = process.cwd();

    try {
      // Host checks.
      const hostChecks: CheckResult[] = [
        await checkDocker(),
        await checkDockerCompose(),
        await checkGit(),
        await checkBun(),
      ];
      const containerRuntime = await detectContainerRuntime();

      this.log("Host:");
      for (const c of hostChecks) {
        if (verbose || c.status !== "ok") {
          this.log(`  ${renderCheck(c)}`);
          if (c.fix && c.status !== "ok") this.log(`      fix: ${c.fix}`);
        } else {
          this.log(`  ${renderCheck(c)}`);
        }
      }
      this.log(`  [INFO] container runtime: ${containerRuntime}`);

      // Config + cohort.
      this.log("Config:");
      const store = new ConfigStore();
      if (await store.exists()) {
        const cfg = await store.read();
        this.log(`  [OK] config at ${store.path}`);
        if (cfg.cohortName) {
          this.log(
            `  [INFO] cohort: ${cfg.cohortName} (${cfg.cohortId ?? "?"}), week ${cfg.currentWeek ?? "?"}`,
          );
        } else {
          this.log(`  [WARN] no cohort recorded — run 'kiln init'.`);
        }

        // Service reachability.
        this.log("Services:");
        const apiUrl = cfg.apiUrl ?? flags["api-url"];
        const api = new KilnApiClient(apiUrl, cfg.authToken);
        const apiReachable = await api.pingWithTimeout(1500);
        this.log(
          `  [${apiReachable ? "OK" : "WARN"}] kiln api: ${apiUrl}${apiReachable ? "" : " (unreachable)"}`,
        );
        if (!apiReachable) {
          this.log("      fix: start the local API with 'bunx turbo dev --filter=@kiln/api'.");
        }
        const anthropicReachable = await pingUrl("https://api.anthropic.com", 1500);
        this.log(
          `  [${anthropicReachable ? "OK" : "WARN"}] anthropic: api.anthropic.com${anthropicReachable ? "" : " (unreachable)"}`,
        );
        const gitlabReachable = await pingUrl("https://gitlab.com", 1500);
        this.log(
          `  [${gitlabReachable ? "OK" : "WARN"}] gitlab: gitlab.com${gitlabReachable ? "" : " (unreachable)"}`,
        );
      } else {
        this.log(`  [WARN] no config at ${store.path} — run 'kiln init'.`);
      }

      // Project checks.
      const autoProject = inspectProject(cwd);
      const shouldCheckProject =
        flags.project === undefined ? autoProject.isProject : flags.project;

      if (shouldCheckProject) {
        this.log("Project:");
        this.log(
          `  [${autoProject.hasDockerfile ? "OK" : "WARN"}] Dockerfile: ${autoProject.hasDockerfile ? "present" : "missing"}`,
        );
        if (!autoProject.hasDockerfile) {
          this.log(
            "      fix: add a Dockerfile or run 'kiln scaffold --adopt' — see the setup guide.",
          );
        }
        this.log(
          `  [${autoProject.hasCompose ? "OK" : "WARN"}] docker-compose: ${autoProject.hasCompose ? "present" : "missing"}`,
        );
        this.log(
          `  [${autoProject.hasKilnDir ? "OK" : "WARN"}] .kiln/: ${autoProject.hasKilnDir ? "present" : "missing"}`,
        );
        this.log(
          `  [${autoProject.hasProxyConfig ? "OK" : "WARN"}] proxy config: ${autoProject.hasProxyConfig ? "present" : "missing"}`,
        );
        this.log(
          `  [${autoProject.hasHarnessJsonl ? "OK" : "INFO"}] harness.jsonl: ${autoProject.hasHarnessJsonl ? "present" : "none yet"}`,
        );

        const runtimes = await discoverRuntimes(cwd);
        if (runtimes.length > 0) {
          this.log("Runtimes:");
          for (const r of runtimes) {
            const ok = r.satisfies ? "OK" : "WARN";
            const want = r.declaredVersion ?? r.minVersion;
            this.log(
              `  [${ok}] ${runtimeLabel(r.runtime)}: ${r.installedVersion ?? "not installed"} (want ≥${want})`,
            );
            if (!r.satisfies && r.fix) this.log(`      fix: ${r.fix}`);
          }
        }
      }
    } catch (err) {
      if (isKilnError(err)) {
        this.log(formatKilnError(err));
        this.exit(1);
      }
      throw err;
    }
  }
}
