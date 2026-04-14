import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { Command, Flags } from "@oclif/core";
import { ConfigStore } from "../lib/config-store.js";
import { KilnError, formatKilnError, isKilnError } from "../lib/errors.js";
import { KilnApiClient, MOCK_WEEK_CONFIG, type WeekConfigResponse } from "../lib/kiln-api.js";
import { discoverRuntimes, runtimeLabel } from "../lib/runtime-discovery.js";
import {
  type ScaffoldMode,
  type ScaffoldResult,
  defaultTemplatesDir,
  generate,
} from "../lib/scaffolder.js";

const execFileP = promisify(execFile);

function isNonEmptyGitRepo(dir: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;
  try {
    const entries = readdirSync(dir).filter(
      (e) => e !== ".git" && e !== ".DS_Store" && e !== "node_modules",
    );
    return entries.length > 0;
  } catch {
    return false;
  }
}

function hasExistingDockerfile(dir: string): boolean {
  return (
    existsSync(join(dir, "Dockerfile")) ||
    existsSync(join(dir, "Containerfile")) ||
    existsSync(join(dir, "docker-compose.yml")) ||
    existsSync(join(dir, "compose.yaml"))
  );
}

async function fetchWeekConfigOrMock(
  apiUrl: string,
  token: string | undefined,
  cohortId: string,
  week: number,
  verbose: boolean,
): Promise<{ config: WeekConfigResponse; mocked: boolean }> {
  // DEFERRED: Phase 5 API — local templates fallback.
  const api = new KilnApiClient(apiUrl, token);
  try {
    const ok = await api.pingWithTimeout(1500);
    if (!ok) {
      if (verbose) p.log.warn(`Kiln API at ${apiUrl} unreachable — using local week config.`);
      return { config: { ...MOCK_WEEK_CONFIG, week }, mocked: true };
    }
    const config = await api.weekConfig(cohortId, week);
    return { config, mocked: false };
  } catch (err) {
    if (verbose) {
      p.log.warn(
        `weekConfig failed (${err instanceof Error ? err.message : String(err)}) — using local fallback.`,
      );
    }
    return { config: { ...MOCK_WEEK_CONFIG, week }, mocked: true };
  }
}

export default class Scaffold extends Command {
  static override description =
    "Generate (or adopt) a Kiln week project: proxy + compose + templates + .kiln harness config.";

  static override examples = [
    "$ kiln scaffold --week 1",
    "$ kiln scaffold --week 2 --no-docker --no-proxy --ci",
    "$ kiln scaffold --week 1 --adopt    # into existing repo",
    "$ kiln scaffold --week 1 --adopt --force",
  ];

  static override flags = {
    week: Flags.integer({ char: "w", description: "Week number (1..N)", required: true }),
    "no-docker": Flags.boolean({ description: "Skip docker compose output." }),
    "no-proxy": Flags.boolean({ description: "Skip building/starting the Kiln proxy." }),
    ci: Flags.boolean({ description: "Non-interactive mode." }),
    verbose: Flags.boolean({ description: "Verbose output." }),
    "template-repo": Flags.string({
      description: "Override templates source (path or git URL). Path only for now.",
    }),
    adopt: Flags.boolean({
      description: "Brownfield mode — install into current directory.",
    }),
    force: Flags.boolean({
      description: "Overwrite skip-if-exists files (requires explicit opt-in).",
    }),
    "api-url": Flags.string({
      description: "Kiln API base URL.",
      default: process.env.KILN_API_URL ?? "http://localhost:4000",
      env: "KILN_API_URL",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Scaffold);
    const verbose = flags.verbose === true;
    const ci = flags.ci === true;
    const cwd = process.cwd();

    try {
      if (!ci) p.intro(`kiln scaffold --week ${flags.week}`);

      // 1. Resolve cohort from local config (or mock).
      const store = new ConfigStore();
      let cohortId = "cohort-dev";
      let cohortName = "dev-local";
      let authToken: string | undefined;
      if (await store.exists()) {
        const cfg = await store.read();
        cohortId = cfg.cohortId ?? cohortId;
        cohortName = cfg.cohortName ?? cohortName;
        authToken = cfg.authToken;
      } else if (verbose) {
        p.log.warn("No ~/.kiln/config.json — using dev-local cohort. Run 'kiln init' first.");
      }

      // 2. Mode detection.
      const brownfield = flags.adopt === true || isNonEmptyGitRepo(cwd);
      const mode: ScaffoldMode = brownfield ? "brownfield" : "greenfield";

      // 3. Dest dir.
      const weekPadded = String(flags.week).padStart(2, "0");
      const destDir = brownfield ? cwd : resolve(cwd, `week-${weekPadded}`);
      if (!brownfield) {
        await mkdir(destDir, { recursive: true });
      }

      // Capture Dockerfile presence BEFORE we generate, so the
      // post-scaffold warning reflects the user's starting state.
      const preExistingDockerfile = brownfield && hasExistingDockerfile(destDir);

      // 4. Fetch week config (or fall back to mock).
      const { config: weekConfig, mocked } = await fetchWeekConfigOrMock(
        flags["api-url"],
        authToken,
        cohortId,
        flags.week,
        verbose,
      );
      if (mocked) {
        this.log(
          `[WARN] using local week-config fallback (Phase 5 API not yet available at ${flags["api-url"]})`,
        );
      }

      // 5. Templates dir.
      const templatesDir = flags["template-repo"] ?? defaultTemplatesDir();

      // 6. Runtime discovery for warnings.
      const runtimes = await discoverRuntimes(destDir);
      if (runtimes.length > 0) {
        this.log("Detected runtimes:");
        for (const r of runtimes) {
          const ok = r.satisfies ? "OK" : "WARN";
          const want = r.declaredVersion ?? r.minVersion;
          this.log(
            `  [${ok}] ${runtimeLabel(r.runtime)}: ${r.installedVersion ?? "not installed"} (want ≥${want})`,
          );
          if (!r.satisfies && r.fix) this.log(`      fix: ${r.fix}`);
        }
      }

      // 7. Generate.
      const result: ScaffoldResult = await generate({
        templatesDir,
        destDir,
        mode,
        week: flags.week,
        vars: {
          week: flags.week,
          cohortId,
          cohortName,
          projectKey: weekConfig.projectKey,
          projectTitle: weekConfig.projectTitle,
          rubricYaml: weekConfig.rubricYaml ?? "",
        },
        force: flags.force,
      });

      // 8. Report.
      if (result.written.length > 0) {
        this.log(`Wrote ${result.written.length} file(s):`);
        for (const r of result.written) this.log(`  + ${r}`);
      }
      if (result.merged.length > 0) {
        this.log(`Merged ${result.merged.length} file(s):`);
        for (const r of result.merged) this.log(`  ~ ${r}`);
      }
      if (result.overwritten.length > 0) {
        this.log(`Overwrote ${result.overwritten.length} file(s):`);
        for (const r of result.overwritten) this.log(`  ! ${r}`);
      }
      if (result.skipped.length > 0) {
        this.log(`Skipped ${result.skipped.length} file(s):`);
        for (const r of result.skipped) this.log(`  skipped (${r.reason}): ${r.path}`);
      }

      // 9. Dockerfile presence check (brownfield) — uses pre-scaffold state.
      if (brownfield && !preExistingDockerfile) {
        this.log(
          "[WARN] No Dockerfile or docker-compose.yml found — you must add one before `kiln audit`/`kiln submit`.",
        );
        this.log("       See Adding a Dockerfile in the setup guide.");
      }

      // 10. Post-scaffold hooks.
      const noProxy = flags["no-proxy"] === true;
      const noDocker = flags["no-docker"] === true;
      const skipHooks = noDocker || noProxy || ci;

      if (!brownfield && !existsSync(join(destDir, ".git"))) {
        if (!skipHooks) {
          await this.runCmd("git", ["init"], destDir, verbose);
        } else if (verbose) {
          this.log("[SKIP] git init (--ci or --no-docker)");
        }
      }

      if (!noProxy && !skipHooks) {
        await this.runCmd("docker", ["compose", "build", "kiln-proxy"], destDir, verbose).catch(
          (err) => {
            this.log(`[WARN] proxy build failed: ${err instanceof Error ? err.message : err}`);
          },
        );
      } else if (verbose) {
        this.log("[SKIP] docker compose build kiln-proxy");
      }

      // 11. Outro.
      if (!ci) {
        if (brownfield) {
          p.outro("Brownfield adopt complete. Next: kiln doctor && docker compose watch");
        } else {
          p.outro(`Greenfield ready. Next: cd week-${weekPadded} && docker compose watch`);
        }
      } else {
        this.log(
          brownfield
            ? `[OK] scaffold brownfield week ${flags.week}`
            : `[OK] scaffold greenfield week ${flags.week} at ${destDir}`,
        );
      }
    } catch (err) {
      if (isKilnError(err)) {
        this.log(formatKilnError(err));
        this.exit(1);
      }
      throw err;
    }
  }

  private async runCmd(cmd: string, args: string[], cwd: string, verbose: boolean): Promise<void> {
    if (verbose) this.log(`$ ${cmd} ${args.join(" ")}`);
    try {
      await execFileP(cmd, args, { cwd, timeout: 120_000 });
    } catch (err) {
      throw new KilnError(`Command failed: ${cmd} ${args.join(" ")}`, {
        fix: `Run manually in ${cwd} and check the output.`,
        code: "HOOK_CMD",
        cause: err,
      });
    }
  }
}
