/**
 * Soft audit — the permissive counterpart to `kiln audit`.
 *
 * Used by `kiln checkpoint` (Phase 6) to summarize project health
 * without blocking progress. Same checks as the strict audit, but
 * classified differently:
 *
 *   - Hard requirements (ONLY these can fail soft audit):
 *       * Git repo initialized
 *       * At least one source file exists
 *       * `.kiln/proxy.yml` present
 *   - Dockerfile/compose gaps → warnings tagged `criterion: "ships"`,
 *     `status: "blocked"` so downstream checkpoint code can downgrade
 *     evaluation coverage rather than fail the run.
 *   - Runtime toolchain mismatches → warnings (student may be on a
 *     different machine than the grader).
 *   - Secret scan hits → warnings (tests run offline, host keys leak
 *     less than CI). `strict` promotes them back to failures.
 */

import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CheckOutcome,
  checkDockerPresence,
  checkRequiredFiles,
  checkRuntimeToolchainParity,
  checkSecretScan,
} from "./checks.js";

export interface SoftAuditWarning {
  name: string;
  message: string;
  fix?: string;
  /** Rubric criterion this gap maps to, if any. */
  criterion?: string;
  /** Whether the criterion is blocked by this gap. */
  status?: "ok" | "blocked";
  details?: Record<string, unknown>;
}

export interface SoftAuditFailure {
  name: string;
  message: string;
  fix: string;
}

export interface SoftAuditResult {
  hardFailures: SoftAuditFailure[];
  warnings: SoftAuditWarning[];
  /** Synthesized coverage hint: { docker_build: "ok" | "skipped (no Dockerfile)" | "failed" } */
  evaluationCoverage: Record<string, string>;
  checks: CheckOutcome[];
}

export interface SoftAuditOptions {
  strict?: boolean;
  skipRuntimeProbes?: boolean;
}

async function hasAnySourceFile(projectDir: string): Promise<boolean> {
  const skip = new Set([".git", "node_modules", ".kiln", "dist", "build", ".turbo"]);
  const sourceExts = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".kt",
    ".cs",
    ".cpp",
    ".c",
    ".h",
    ".hpp",
    ".swift",
    ".m",
    ".mm",
    ".php",
    ".ex",
    ".exs",
    ".clj",
    ".cljs",
  ]);

  async function walk(dir: string): Promise<boolean> {
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await walk(abs)) return true;
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf(".");
        if (dot >= 0 && sourceExts.has(entry.name.slice(dot))) return true;
      }
    }
    return false;
  }

  return walk(projectDir);
}

export async function runSoftAudit(
  projectDir: string,
  options: SoftAuditOptions = {},
): Promise<SoftAuditResult> {
  const outcomes: CheckOutcome[] = [];
  const hardFailures: SoftAuditFailure[] = [];
  const warnings: SoftAuditWarning[] = [];
  const coverage: Record<string, string> = {};

  // Hard requirement 1: Git repo initialized
  const gitExists = existsSync(join(projectDir, ".git"));
  if (!gitExists) {
    hardFailures.push({
      name: "git-init",
      message: "no .git directory — project is not a git repository",
      fix: "git init && git add . && git commit -m 'initial'",
    });
  }
  outcomes.push({
    name: "git-init",
    level: gitExists ? "pass" : "fail",
    message: gitExists ? "git repo initialized" : "no .git directory",
    fix: gitExists ? undefined : "git init",
  });

  // Hard requirement 2: At least one source file exists
  const hasSource = await hasAnySourceFile(projectDir);
  if (!hasSource) {
    hardFailures.push({
      name: "source-present",
      message: "no source files found",
      fix: "Add at least one source file under the project root.",
    });
  }
  outcomes.push({
    name: "source-present",
    level: hasSource ? "pass" : "fail",
    message: hasSource ? "source files found" : "no source files",
  });

  // Hard requirement 3: .kiln/proxy.yml present
  const proxyYmlExists = existsSync(join(projectDir, ".kiln", "proxy.yml"));
  if (!proxyYmlExists) {
    hardFailures.push({
      name: "proxy-yml",
      message: ".kiln/proxy.yml missing",
      fix: "kiln scaffold --week <N>",
    });
  }
  outcomes.push({
    name: "proxy-yml",
    level: proxyYmlExists ? "pass" : "fail",
    message: proxyYmlExists ? "proxy.yml present" : ".kiln/proxy.yml missing",
  });

  // Required files (everything else is a warning in soft mode)
  const fileOutcomes = checkRequiredFiles(projectDir);
  for (const o of fileOutcomes) {
    if (o.name === "required:.kiln/proxy.yml") continue; // handled above
    if (o.level === "fail") {
      warnings.push({
        name: o.name,
        message: o.message,
        fix: o.fix,
      });
      outcomes.push({ ...o, level: "warn" });
    } else {
      outcomes.push(o);
    }
  }

  // Dockerfile presence — warning with criterion: ships, status: blocked
  const presence = checkDockerPresence(projectDir);
  if (presence.level === "fail") {
    warnings.push({
      name: "docker-presence",
      message: presence.message,
      fix: presence.fix,
      criterion: "ships",
      status: "blocked",
    });
    coverage.docker_build = "skipped (no Dockerfile)";
    outcomes.push({ ...presence, level: "warn" });
  } else {
    coverage.docker_build = "ok";
    outcomes.push(presence);
  }

  // Runtime parity — always warnings in soft mode
  const runtimeOutcomes = await checkRuntimeToolchainParity(projectDir, {
    skipProbes: options.skipRuntimeProbes,
  });
  for (const o of runtimeOutcomes) {
    if (o.level === "fail") {
      warnings.push({
        name: o.name,
        message: o.message,
        fix: o.fix,
      });
      outcomes.push({ ...o, level: "warn" });
    } else {
      outcomes.push(o);
    }
  }

  // Secret scan — warnings in soft mode, unless strict
  try {
    const secretOutcome = await checkSecretScan(projectDir);
    if (secretOutcome.level === "fail") {
      if (options.strict) {
        hardFailures.push({
          name: "secret-scan",
          message: secretOutcome.message,
          fix: secretOutcome.fix ?? "Remove secrets from source tree",
        });
        outcomes.push(secretOutcome);
      } else {
        warnings.push({
          name: "secret-scan",
          message: secretOutcome.message,
          fix: secretOutcome.fix,
          details: secretOutcome.details,
        });
        outcomes.push({ ...secretOutcome, level: "warn" });
      }
    } else {
      outcomes.push(secretOutcome);
    }
  } catch {
    // scan errors are non-fatal in soft mode
  }

  return {
    hardFailures,
    warnings,
    evaluationCoverage: coverage,
    checks: outcomes,
  };
}
