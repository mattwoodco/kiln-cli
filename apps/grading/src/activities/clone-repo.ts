import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CloneRepoInput, CloneRepoResult } from "./types.js";

/**
 * Shallow-clone a repo at a specific commit into a temp workspace.
 * Records `git_clone_duration_ms` for the pipeline usage event.
 */
export async function cloneRepo(input: CloneRepoInput): Promise<CloneRepoResult> {
  const start = Date.now();
  const workspacePath = await mkdtemp(path.join(tmpdir(), `kiln-${input.submissionId}-`));

  // Clone the default branch shallowly, then fetch and check out the commit.
  // Using `--depth=1` twice because GitLab shallow fetch of an arbitrary
  // commit requires uploadpack.allowReachableSHA1InWant on the server side.
  await runGit(["clone", "--depth", "1", input.repoUrl, workspacePath]);
  // Best-effort checkout — if the commit isn't reachable from depth=1,
  // fall back to an unshallow + checkout.
  try {
    await runGit(["checkout", input.commitSha], workspacePath);
  } catch {
    await runGit(["fetch", "--unshallow"], workspacePath);
    await runGit(["checkout", input.commitSha], workspacePath);
  }

  return {
    workspacePath,
    gitCloneDurationMs: Date.now() - start,
  };
}

function runGit(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}
