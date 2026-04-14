import { spawn } from "node:child_process";
import { Command, Flags } from "@oclif/core";
import { ConfigStore } from "../lib/config-store.js";
import { KilnError, formatKilnError, isKilnError } from "../lib/errors.js";

/**
 * kiln submit — audits, pushes, and hands off to the grading pipeline.
 *
 * Phase 8 hardening:
 *   - `git push` retries 3x with exponential backoff (1s, 3s, 9s).
 *   - `GITLAB_TOKEN` is redacted from every error and log surface.
 *   - After push, verify the pushed commit SHA matches local HEAD.
 *   - Every non-zero exit surfaces a `KilnError` with a `fix` hint.
 */
export default class Submit extends Command {
  static override description = "Audit, push, and submit the current project for grading.";

  static override flags = {
    stage: Flags.string({
      description: "Early dress-rehearsal run or final graded run.",
      options: ["early", "final"],
      default: "final",
    }),
    week: Flags.integer({
      description: "Week number for this submission.",
      required: true,
    }),
    repo: Flags.string({
      description: "Git repo URL (defaults to current repo's origin).",
    }),
    commit: Flags.string({
      description: "Commit SHA to submit (defaults to HEAD).",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Submit);
    try {
      const store = new ConfigStore();
      const config = await store.read();
      const apiUrl = config.apiUrl ?? process.env.KILN_API_URL ?? "http://localhost:4000";
      const token = config.authToken ?? process.env.KILN_TOKEN ?? "";

      // TODO(phase-4): call the Phase 4 audit lib here. For now, warn and continue.
      this.warn("audit step skipped — Phase 4 will wire the audit lib into submit.");

      const repoUrl = (
        flags.repo ?? (await runGit(["config", "--get", "remote.origin.url"]))
      ).trim();
      const commitSha = (flags.commit ?? (await runGit(["rev-parse", "HEAD"]))).trim();

      if (!flags.repo) {
        // Push HEAD before handing off, with retry.
        await gitPushWithRetry();

        // Verify remote now has our commit.
        await verifyRemoteCommit(commitSha);
      }

      const body = {
        repoUrl,
        commitSha,
        weekNumber: flags.week,
        stage: flags.stage,
      };

      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/submissions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new KilnError(
          `Could not reach the Kiln API at ${apiUrl}: ${redactTokens((err as Error).message)}`,
          {
            code: "submit_api_unreachable",
            fix: "Check KILN_API_URL, your network, or run `kiln doctor`.",
            cause: err,
          },
        );
      }
      if (!res.ok) {
        const rawBody = await res.text();
        throw new KilnError(
          `Kiln API rejected submission: ${res.status} ${redactTokens(rawBody)}`,
          {
            code: "submit_rejected",
            fix: "Check the `kiln submit` arguments (week, stage, commit). Re-run with --verbose once the issue is fixed.",
          },
        );
      }
      const payload = (await res.json()) as { submissionId: string; jobId: string };
      this.log(`submitted: ${payload.submissionId} (job ${payload.jobId})`);
    } catch (err) {
      if (isKilnError(err)) {
        this.log(formatKilnError(err));
        this.exit(1);
      }
      throw err;
    }
  }
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    child.once("error", (e) =>
      reject(
        new KilnError(`git ${args.join(" ")} spawn failed: ${redactTokens(e.message)}`, {
          code: "git_spawn_failed",
          fix: "Ensure `git` is installed and on your PATH.",
          cause: e,
        }),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) resolve(out);
      else
        reject(
          new KilnError(
            `git ${args.join(" ")} exited ${code}: ${redactTokens(err || out || "(no output)")}`,
            {
              code: "git_failed",
              fix: "Inspect the git error above. If it mentions authentication, run `kiln doctor` and confirm GITLAB_TOKEN is set.",
            },
          ),
        );
    });
  });
}

/**
 * Retry `git push` up to 3 times with exponential backoff. Redacts
 * GITLAB_TOKEN from any error output and surfaces a clear KilnError.
 *
 * We deliberately do NOT use `--force` — transient failures must be
 * resolved by the student (e.g. pull + rebase), not blind overwrite.
 */
async function gitPushWithRetry(): Promise<void> {
  const delays = [1000, 3000, 9000];
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await runGit(["push", "origin", "HEAD"]);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await sleep(delays[attempt] ?? 1000);
      }
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new KilnError(`git push failed after 3 attempts: ${redactTokens(msg)}`, {
    code: "git_push_failed",
    fix: "Check your GitLab credentials. For HTTPS, set GITLAB_TOKEN. For SSH, verify `ssh -T git@gitlab.com`. Then rerun `kiln submit`.",
    cause: lastError,
  });
}

/**
 * Query the remote to confirm our local commit exists there. This is a
 * cheap safety net that catches the case where `git push` silently
 * succeeded to the wrong remote or was swallowed by a pre-push hook.
 *
 * Uses `git ls-remote origin HEAD` to read the remote HEAD SHA without
 * fetching anything.
 */
async function verifyRemoteCommit(expectedSha: string): Promise<void> {
  try {
    const raw = await runGit(["ls-remote", "origin", "HEAD"]);
    const remoteSha = raw.split(/\s+/)[0]?.trim() ?? "";
    if (!remoteSha) {
      throw new KilnError("git ls-remote returned empty — cannot verify remote HEAD", {
        code: "git_verify_failed",
        fix: "Check your origin URL and run `git ls-remote origin HEAD` manually.",
      });
    }
    if (remoteSha !== expectedSha) {
      throw new KilnError(
        `Remote HEAD (${remoteSha.slice(0, 10)}) does not match local HEAD (${expectedSha.slice(0, 10)}). Push may not have landed.`,
        {
          code: "git_remote_mismatch",
          fix: "Rerun `git push origin HEAD`, resolve any non-fast-forward issues, then rerun `kiln submit`.",
        },
      );
    }
  } catch (err) {
    if (isKilnError(err)) throw err;
    throw new KilnError(`Could not verify remote commit: ${redactTokens((err as Error).message)}`, {
      code: "git_verify_failed",
      fix: "Run `git ls-remote origin HEAD` and compare the SHA to `git rev-parse HEAD`.",
      cause: err,
    });
  }
}

function redactTokens(s: string): string {
  const token = process.env.GITLAB_TOKEN;
  let out = s;
  if (token) out = out.split(token).join("[REDACTED]");
  // Also redact embedded user:password@ in URLs as a safety net.
  out = out.replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@");
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
