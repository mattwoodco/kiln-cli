import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { BuildDockerInput, BuildDockerResult } from "./types.js";

/**
 * Build the student's docker image via `docker compose build`.
 *
 * Plan rules (§5 step 7):
 *  - 5-minute timeout.
 *  - 1GB memory cap (enforced at docker daemon level; not wired here).
 *  - Missing Dockerfile or compose file → return `{status: "missing"}`.
 *    (Not thrown — the workflow still continues to code analysis.)
 *  - Build failure → return `{status: "failed"}` with exit code + last 40
 *    log lines. Also NOT thrown.
 *  - Activity failure only fires on infra-level issues (daemon unreachable).
 */
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

export async function buildDocker(input: BuildDockerInput): Promise<BuildDockerResult> {
  const start = Date.now();

  const composeFile = path.join(input.workspacePath, "docker-compose.yml");
  const dockerfile = path.join(input.workspacePath, "Dockerfile");
  const hasCompose = await fileExists(composeFile);
  const hasDockerfile = await fileExists(dockerfile);

  if (!hasCompose && !hasDockerfile) {
    return {
      status: "missing",
      reason: "no_dockerfile_or_compose",
      affectedCriteria: ["Ships", "Resilience"],
      dockerBuildDurationMs: Date.now() - start,
    };
  }

  try {
    const { exitCode, logs } = await spawnCompose(
      ["compose", "build", "--progress", "plain"],
      input.workspacePath,
      BUILD_TIMEOUT_MS,
    );
    const duration = Date.now() - start;
    if (exitCode === 0) {
      return {
        status: "ok",
        dockerBuildDurationMs: duration,
        imageRef: `kiln-${input.submissionId}`,
      };
    }
    return {
      status: "failed",
      exitCode,
      logsTail: tailLines(logs, 40),
      affectedCriteria: ["Ships"],
      dockerBuildDurationMs: duration,
    };
  } catch (err) {
    // Infra-level failure. Re-throw so Temporal can retry.
    throw new Error(`docker_daemon_unreachable: ${(err as Error).message}`);
  }
}

async function fileExists(fp: string): Promise<boolean> {
  try {
    await access(fp);
    return true;
  } catch {
    return false;
  }
}

function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

interface ComposeResult {
  exitCode: number;
  logs: string;
}

function spawnCompose(args: string[], cwd: string, timeoutMs: number): Promise<ComposeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd, stdio: "pipe" });
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: 124, logs: `${buf}\n[killed after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, logs: buf });
    });
  });
}
