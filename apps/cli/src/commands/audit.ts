import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuditCheck, type AuditResult, AuditResultSchema } from "@kiln/shared";
import { Command, Flags } from "@oclif/core";
import {
  type CheckOutcome,
  type Spawner,
  checkCaptureIntegrity,
  checkDockerBuild,
  checkDockerPresence,
  checkRequiredFiles,
  checkRuntimeToolchainParity,
  checkSecretScan,
  defaultSpawner,
  summarizeRequiredFiles,
} from "../lib/audit/checks.js";
import { formatKilnError, isKilnError } from "../lib/errors.js";

function toAuditCheck(o: CheckOutcome): AuditCheck {
  const status =
    o.level === "pass"
      ? "pass"
      : o.level === "warn"
        ? "warn"
        : o.level === "skip"
          ? "skip"
          : "fail";
  return {
    name: o.name,
    status,
    message: o.message,
    fix: o.fix,
    details: o.details,
  };
}

function fmtLine(o: CheckOutcome): string {
  const icon =
    o.level === "pass"
      ? "[OK]"
      : o.level === "warn"
        ? "[WARN]"
        : o.level === "skip"
          ? "[SKIP]"
          : "[FAIL]";
  let extra = "";
  // For the secret-scan check, print every offending file + pattern so
  // the user can navigate directly to the hit. Only the pattern *name*
  // is shown — the matched string itself is never echoed.
  if (o.name === "secret-scan" && o.level === "fail" && o.details?.hits) {
    const hits = o.details.hits as Array<{ file: string; pattern: string }>;
    extra = `\n${hits.map((h) => `      ! ${h.pattern} → ${h.file}`).join("\n")}`;
  }
  return `  ${icon} ${o.name}: ${o.message}${o.fix ? `  fix: ${o.fix}` : ""}${extra}`;
}

const CHAOS_CONFIG_TEMPLATE = `# kiln chaos-config — steady-state endpoints for the week's project.
steady_state:
  endpoints:
    - name: health
      method: GET
      url: http://app:8080/health
      expect_status: 200
  duration_seconds: 60

experiments:
  []
`;

/**
 * Trivially-fixable outcomes: create missing `.kiln/chaos-config.yml`.
 * Does NOT touch Dockerfiles, source code, or anything destructive.
 */
async function tryAutoFix(projectDir: string, outcomes: CheckOutcome[]): Promise<string[]> {
  const fixed: string[] = [];
  const missingChaos = outcomes.find(
    (o) => o.name === "required:.kiln/chaos-config.yml" && o.level === "fail",
  );
  if (missingChaos) {
    const dir = join(projectDir, ".kiln");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, "chaos-config.yml"), CHAOS_CONFIG_TEMPLATE, "utf8");
    fixed.push(".kiln/chaos-config.yml");
  }
  return fixed;
}

export default class Audit extends Command {
  static override description =
    "Audit the current project for kiln compliance (files, Dockerfile, runtimes, capture integrity, secrets).";

  static override examples = [
    "$ kiln audit",
    "$ kiln audit --verbose",
    "$ kiln audit --ci",
    "$ kiln audit --fix",
    "$ kiln audit --full",
  ];

  static override flags = {
    verbose: Flags.boolean({ description: "Per-check trace with timings" }),
    fix: Flags.boolean({ description: "Auto-apply trivial fixes where safe" }),
    ci: Flags.boolean({ description: "Machine-readable JSON output" }),
    full: Flags.boolean({
      description: "Also run the slow checks: docker up health, capture integrity, secret scan.",
    }),
    strict: Flags.boolean({
      description: "Treat capture-integrity warnings as failures.",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Audit);
    const cwd = process.cwd();
    const outcomes: CheckOutcome[] = [];
    const spawner: Spawner = defaultSpawner;
    let autoFixed: string[] = [];

    try {
      // 1. Required files
      const fileOutcomes = checkRequiredFiles(cwd);
      if (flags.fix) {
        autoFixed = await tryAutoFix(cwd, fileOutcomes);
        if (autoFixed.length > 0) {
          // Re-check the files we fixed.
          for (const f of autoFixed) {
            const idx = fileOutcomes.findIndex((o) => o.name === `required:${f}`);
            if (idx !== -1) {
              fileOutcomes[idx] = {
                name: `required:${f}`,
                level: "pass",
                message: `present: ${f} (auto-fixed)`,
              };
            }
          }
        }
      }
      outcomes.push(summarizeRequiredFiles(fileOutcomes));
      if (flags.verbose) outcomes.push(...fileOutcomes);

      // 2. Dockerfile/compose presence
      const presence = checkDockerPresence(cwd);
      outcomes.push(presence);

      // 3. Dockerfile buildability — only if presence passed
      if (presence.level === "pass") {
        const build = await checkDockerBuild(cwd, spawner).catch((err) => ({
          name: "docker-build",
          level: "fail" as const,
          message: `docker compose build threw: ${err instanceof Error ? err.message : String(err)}`,
          fix: "Check `docker info` and retry `docker compose build`.",
        }));
        outcomes.push(build);
      } else {
        outcomes.push({
          name: "docker-build",
          level: "skip",
          message: "skipped — Dockerfile/compose missing",
        });
      }

      // 4. Runtime toolchain parity
      const runtimeOutcomes = await checkRuntimeToolchainParity(cwd);
      outcomes.push(...runtimeOutcomes);

      // --full gates 5, 6, 7 (the expensive ones)
      if (flags.full) {
        // 5. Docker compose up health — DEFERRED actual implementation
        // (infrastructure wait logic lives in proxy/start; we just mark it skipped).
        outcomes.push({
          name: "docker-up-health",
          level: "skip",
          message:
            "full health-check is deferred — run `kiln proxy start` + `docker compose up` manually",
        });

        // 6. Capture integrity
        const capture = await checkCaptureIntegrity(cwd, flags.strict === true);
        outcomes.push(capture);

        // 7. Secret scan
        const secrets = await checkSecretScan(cwd);
        outcomes.push(secrets);
      }

      // Render
      const failures = outcomes.filter((o) => o.level === "fail");
      const warnings = outcomes.filter((o) => o.level === "warn");
      const passed = failures.length === 0;

      const auditResult: AuditResult = AuditResultSchema.parse({
        passed,
        checks: outcomes.map(toAuditCheck),
        warnings: warnings.map((w) => w.message),
        generated_at: new Date().toISOString(),
      });

      if (flags.ci) {
        this.log(JSON.stringify(auditResult, null, 2));
      } else {
        if (flags.verbose) {
          for (const o of outcomes) this.log(fmtLine(o));
        } else {
          for (const o of outcomes) {
            if (o.level === "pass" && !flags.verbose) {
              this.log(`  [OK] ${o.name}: ${o.message}`);
            } else {
              this.log(fmtLine(o));
            }
          }
        }
        if (autoFixed.length > 0) {
          this.log(`  [FIXED] ${autoFixed.join(", ")}`);
        }
        this.log(
          `audit: ${failures.length} failure${failures.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
        );
      }

      if (!passed) this.exit(1);
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
