/**
 * Shared audit primitives used by both `kiln audit` (strict) and
 * `lib/audit/soft-audit` (permissive checkpoint mode).
 *
 * Each check returns a structured result; the caller decides whether
 * to surface as a hard failure or a warning.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { HarnessLogEntrySchema } from "@kiln/shared";
import {
  type DetectedRuntime,
  type DiscoverOptions,
  discoverRuntimes,
} from "../runtime-discovery.js";

export type CheckLevel = "pass" | "warn" | "fail" | "skip";

export interface CheckOutcome {
  name: string;
  level: CheckLevel;
  message: string;
  fix?: string;
  /** Optional tag used by the checkpoint soft-audit to bind a check to a rubric criterion. */
  criterion?: string;
  /** Optional machine-readable extras */
  details?: Record<string, unknown>;
  /** Optional duration in ms */
  duration_ms?: number;
}

export interface RequiredFileSpec {
  /** Path relative to project dir. */
  path: string;
  /** Scaffold command that creates it. */
  fix: string;
}

export const REQUIRED_FILES: RequiredFileSpec[] = [
  {
    path: ".kiln",
    fix: "kiln scaffold --week <N>  (or add --adopt for brownfield)",
  },
  { path: ".kiln/proxy.yml", fix: "kiln scaffold --week <N>" },
  { path: ".kiln/rubric.yml", fix: "kiln scaffold --week <N>" },
  { path: ".kiln/chaos-config.yml", fix: "kiln scaffold --week <N>" },
  { path: ".kiln/spec.md", fix: "kiln scaffold --week <N>" },
  { path: ".kiln/video.md", fix: "kiln scaffold --week <N>" },
  { path: "Makefile", fix: "kiln scaffold --week <N>" },
  { path: "README.md", fix: "kiln scaffold --week <N>" },
];

export function checkRequiredFiles(projectDir: string): CheckOutcome[] {
  const outcomes: CheckOutcome[] = [];
  for (const spec of REQUIRED_FILES) {
    const abs = join(projectDir, spec.path);
    if (existsSync(abs)) {
      outcomes.push({
        name: `required:${spec.path}`,
        level: "pass",
        message: `present: ${spec.path}`,
      });
    } else {
      outcomes.push({
        name: `required:${spec.path}`,
        level: "fail",
        message: `missing: ${spec.path}`,
        fix: spec.fix,
      });
    }
  }
  return outcomes;
}

export function summarizeRequiredFiles(outcomes: CheckOutcome[]): CheckOutcome {
  const missing = outcomes.filter((o) => o.level === "fail");
  if (missing.length === 0) {
    return {
      name: "required-files",
      level: "pass",
      message: `${REQUIRED_FILES.length} files present`,
    };
  }
  return {
    name: "required-files",
    level: "fail",
    message: `${missing.length}/${REQUIRED_FILES.length} required files missing`,
    fix: missing[0]?.fix ?? "kiln scaffold --week <N>",
    details: { missing: missing.map((m) => m.name) },
  };
}

export function checkDockerPresence(projectDir: string): CheckOutcome {
  const hasDockerfile =
    existsSync(join(projectDir, "Dockerfile")) || existsSync(join(projectDir, "Containerfile"));
  const hasCompose =
    existsSync(join(projectDir, "docker-compose.yml")) ||
    existsSync(join(projectDir, "compose.yaml"));
  if (hasDockerfile && hasCompose) {
    return {
      name: "docker-presence",
      level: "pass",
      message: "Dockerfile + compose present",
      criterion: "ships",
    };
  }
  const missing: string[] = [];
  if (!hasDockerfile) missing.push("Dockerfile / Containerfile");
  if (!hasCompose) missing.push("docker-compose.yml / compose.yaml");
  return {
    name: "docker-presence",
    level: "fail",
    message: `missing: ${missing.join(", ")}`,
    fix: "Add a Dockerfile — see docs/adding-a-dockerfile.md",
    criterion: "ships",
  };
}

export type Spawner = (
  cmd: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export async function defaultSpawner(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const bun = (globalThis as { Bun?: { spawn?: unknown } }).Bun;
  if (bun && typeof bun.spawn === "function") {
    type BunSpawnProc = {
      exited: Promise<number>;
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      kill: () => void;
    };
    type BunSpawn = (args: {
      cmd: string[];
      cwd?: string;
      stdout: "pipe";
      stderr: "pipe";
    }) => BunSpawnProc;
    const spawn = bun.spawn as BunSpawn;
    const proc = spawn({ cmd, cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => proc.kill(), opts.timeoutMs);
    }
    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { exitCode: code, stdout, stderr };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  // Fallback for Node: child_process. Dynamically imported so the module still
  // loads under Bun without paying the cost.
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const proc = spawn(cmd[0] ?? "", cmd.slice(1), { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
    }
    proc.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

export async function checkDockerBuild(
  projectDir: string,
  spawner: Spawner = defaultSpawner,
  timeoutMs = 300_000,
): Promise<CheckOutcome> {
  const started = Date.now();
  const res = await spawner(["docker", "compose", "build"], {
    cwd: projectDir,
    timeoutMs,
  });
  const duration_ms = Date.now() - started;
  if (res.exitCode === 0) {
    return {
      name: "docker-build",
      level: "pass",
      message: `docker compose build succeeded in ${(duration_ms / 1000).toFixed(1)}s`,
      criterion: "ships",
      duration_ms,
    };
  }
  return {
    name: "docker-build",
    level: "fail",
    message: "docker compose build failed",
    fix: "Fix Dockerfile/compose errors and re-run. Build log tail below.",
    criterion: "ships",
    duration_ms,
    details: { buildLogTail: tailLines(`${res.stdout}\n${res.stderr}`, 40) },
  };
}

export async function checkRuntimeToolchainParity(
  projectDir: string,
  discoverOpts: DiscoverOptions = {},
): Promise<CheckOutcome[]> {
  const runtimes: DetectedRuntime[] = await discoverRuntimes(projectDir, discoverOpts);
  return runtimes.map((r) => {
    const want = r.declaredVersion ?? r.minVersion;
    if (r.satisfies) {
      return {
        name: `runtime:${r.runtime}`,
        level: "pass",
        message: `${r.runtime} ${r.installedVersion} ≥ ${want}`,
      };
    }
    return {
      name: `runtime:${r.runtime}`,
      level: "fail",
      message: `${r.runtime} ${r.installedVersion ?? "not installed"} < ${want}`,
      fix: r.fix ?? "Install the required toolchain.",
    };
  });
}

/**
 * Validate a Kiln harness capture. Missing file is reported as a skip
 * (not a failure) unless `strict` is set.
 */
export async function checkCaptureIntegrity(
  projectDir: string,
  strict: boolean,
): Promise<CheckOutcome> {
  const harnessPath = join(projectDir, ".kiln", "harness.jsonl");
  if (!existsSync(harnessPath)) {
    if (strict) {
      return {
        name: "capture-integrity",
        level: "fail",
        message: "harness.jsonl missing",
        fix: "kiln proxy start && run the harness at least once before auditing.",
      };
    }
    return {
      name: "capture-integrity",
      level: "warn",
      message: "no harness.jsonl yet (proxy has not been exercised)",
      fix: "kiln proxy start",
    };
  }
  const raw = await readFile(harnessPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  let ok = 0;
  let bad = 0;
  const perTool = new Map<string, number>();
  let minTs: number | undefined;
  let maxTs: number | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const validated = HarnessLogEntrySchema.parse(parsed);
      ok += 1;
      perTool.set(validated.source_tool, (perTool.get(validated.source_tool) ?? 0) + 1);
      const ts = Date.parse(validated.timestamp);
      if (!Number.isNaN(ts)) {
        if (minTs === undefined || ts < minTs) minTs = ts;
        if (maxTs === undefined || ts > maxTs) maxTs = ts;
      }
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) {
    return {
      name: "capture-integrity",
      level: "fail",
      message: `harness.jsonl: ${bad}/${lines.length} invalid line(s)`,
      fix: "Re-capture with a fresh `kiln proxy start` — old lines may be truncated.",
      details: { ok, bad, perTool: Object.fromEntries(perTool.entries()) },
    };
  }
  const span = minTs !== undefined && maxTs !== undefined ? maxTs - minTs : undefined;
  return {
    name: "capture-integrity",
    level: "pass",
    message: `harness.jsonl: ${ok} valid entries`,
    details: {
      ok,
      perTool: Object.fromEntries(perTool.entries()),
      timestamp_span_ms: span,
    },
  };
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "anthropic", pattern: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { name: "openai", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "gitlab-pat", pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: "github-pat", pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._\-]{20,}/ },
];

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".kiln",
  "target",
  "venv",
  ".venv",
]);

const SCAN_MAX_FILE_BYTES = 512 * 1024; // 512 KB per file

async function walkFiles(root: string, cb: (path: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(abs, cb);
    } else if (entry.isFile()) {
      await cb(abs);
    }
  }
}

export interface SecretHit {
  file: string;
  pattern: string;
}

export async function scanForSecrets(projectDir: string): Promise<SecretHit[]> {
  const hits: SecretHit[] = [];
  await walkFiles(projectDir, async (abs) => {
    try {
      const s = await stat(abs);
      if (s.size > SCAN_MAX_FILE_BYTES) return;
    } catch {
      return;
    }
    let text = "";
    try {
      text = await readFile(abs, "utf8");
    } catch {
      return;
    }
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        hits.push({ file: relative(projectDir, abs), pattern: name });
      }
    }
  });
  return hits;
}

export async function checkSecretScan(projectDir: string): Promise<CheckOutcome> {
  const hits = await scanForSecrets(projectDir);
  if (hits.length === 0) {
    return {
      name: "secret-scan",
      level: "pass",
      message: "no secrets detected in build context",
    };
  }
  return {
    name: "secret-scan",
    level: "fail",
    message: `${hits.length} secret(s) detected`,
    fix: "Remove secrets from source tree and use .env files",
    details: { hits },
  };
}
