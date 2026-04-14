import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareVersions } from "./runtime-discovery.js";

const execFileP = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export type ContainerRuntime = "orbstack" | "docker-desktop" | "docker-engine" | "unknown";

async function runCmd(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: 10_000 });
    return { stdout, stderr, ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    return { stdout, stderr, ok: false };
  }
}

function extractVersion(s: string): string | undefined {
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return undefined;
  return `${m[1]}.${m[2]}.${m[3] ?? 0}`;
}

export async function checkDocker(min = "27.0.0"): Promise<CheckResult> {
  const { stdout, ok } = await runCmd("docker", ["--version"]);
  if (!ok) {
    return {
      name: "docker",
      status: "fail",
      detail: "docker CLI not found on PATH",
      fix: "Install OrbStack (`brew install orbstack`) or Docker Desktop.",
    };
  }
  const v = extractVersion(stdout);
  if (!v) {
    return {
      name: "docker",
      status: "warn",
      detail: `unable to parse docker version: ${stdout.trim()}`,
      fix: "Upgrade to Docker ≥27.",
    };
  }
  if (compareVersions(v, min) < 0) {
    return {
      name: "docker",
      status: "fail",
      detail: `docker ${v} < ${min}`,
      fix: "Upgrade Docker to ≥27: `brew upgrade orbstack` or update Docker Desktop.",
    };
  }
  return { name: "docker", status: "ok", detail: `docker ${v}` };
}

export async function checkDockerCompose(min = "2.20.0"): Promise<CheckResult> {
  const { stdout, ok } = await runCmd("docker", ["compose", "version"]);
  if (!ok) {
    return {
      name: "docker-compose",
      status: "fail",
      detail: "docker compose plugin not available",
      fix: "Upgrade Docker; the compose plugin ships with Docker ≥20.10.",
    };
  }
  const v = extractVersion(stdout);
  if (!v || compareVersions(v, min) < 0) {
    return {
      name: "docker-compose",
      status: "fail",
      detail: `compose ${v ?? "?"} < ${min}`,
      fix: "Upgrade Docker Desktop or OrbStack to get compose ≥2.20.",
    };
  }
  return { name: "docker-compose", status: "ok", detail: `compose ${v}` };
}

export async function checkGit(min = "2.40.0"): Promise<CheckResult> {
  const { stdout, ok } = await runCmd("git", ["--version"]);
  if (!ok) {
    return {
      name: "git",
      status: "fail",
      detail: "git not found",
      fix: "`brew install git` or equivalent.",
    };
  }
  const v = extractVersion(stdout);
  if (!v || compareVersions(v, min) < 0) {
    return {
      name: "git",
      status: "warn",
      detail: `git ${v ?? "?"} < ${min}`,
      fix: "Upgrade git: `brew upgrade git`.",
    };
  }
  return { name: "git", status: "ok", detail: `git ${v}` };
}

export async function checkBun(min = "1.0.0"): Promise<CheckResult> {
  const { stdout, ok } = await runCmd("bun", ["--version"]);
  if (!ok) {
    return {
      name: "bun",
      status: "fail",
      detail: "bun not found",
      fix: "`curl -fsSL https://bun.sh/install | bash`.",
    };
  }
  const v = extractVersion(stdout);
  if (!v || compareVersions(v, min) < 0) {
    return {
      name: "bun",
      status: "fail",
      detail: `bun ${v ?? "?"} < ${min}`,
      fix: "Upgrade bun: `bun upgrade`.",
    };
  }
  return { name: "bun", status: "ok", detail: `bun ${v}` };
}

export async function detectContainerRuntime(): Promise<ContainerRuntime> {
  // Try OrbStack first.
  const orb = await runCmd("orb", ["version"]);
  if (orb.ok) return "orbstack";
  const info = await runCmd("docker", ["info", "--format", "{{.Name}}"]);
  if (info.ok) {
    const name = info.stdout.toLowerCase();
    if (name.includes("orbstack")) return "orbstack";
    if (name.includes("desktop")) return "docker-desktop";
    return "docker-engine";
  }
  return "unknown";
}

export async function checkHost(): Promise<CheckResult[]> {
  return Promise.all([checkDocker(), checkDockerCompose(), checkGit(), checkBun()]);
}
