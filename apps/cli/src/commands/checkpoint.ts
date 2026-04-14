import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import type { CheckpointReport } from "@kiln/shared";
import { Command, Flags } from "@oclif/core";
import { runSoftAudit } from "../lib/audit/soft-audit.js";
import { ConfigStore } from "../lib/config-store.js";
import { KilnError, formatKilnError, isKilnError } from "../lib/errors.js";

/**
 * Fetch with retry for transient network/API unreachable errors.
 * Retries up to 3 times with exponential backoff (1s, 3s, 9s) when
 * the fetch throws or returns a 5xx response.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { attempts?: number } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const delays = [1000, 3000, 9000];
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && res.status < 600 && i < attempts - 1) {
        lastError = new Error(`upstream ${res.status}`);
        await sleep(delays[i] ?? 1000);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await sleep(delays[i] ?? 1000);
    }
  }
  throw new KilnError(
    `Kiln API at ${stripHost(url)} unreachable after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    {
      code: "api_unreachable",
      fix: "Check that the API server is running (`kiln doctor`), KILN_API_URL is correct, and your network allows outbound HTTP.",
      cause: lastError,
    },
  );
}

function stripHost(url: string): string {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return url;
  }
}

/**
 * kiln checkpoint — student-initiated formative checkpoint.
 *
 * Plan ref: Phase 6 §6 (lines 1018-1030).
 *
 * Steps:
 *   1. Run the soft-audit. Hard failures block; warnings surface but do
 *      not block.
 *   2. Git push to GitLab (authenticated with GITLAB_TOKEN if present,
 *      otherwise fall back to host credentials).
 *   3. POST /api/checkpoints with the current commit SHA.
 *   4. Poll GET /api/status/:jobId with a Clack spinner (<90s expected).
 *   5. Fetch GET /api/checkpoints/:id and render the report.
 *
 * Flags: --ci, --verbose, --persist
 */
export default class Checkpoint extends Command {
  static override description =
    "Run a mid-week formative checkpoint against the current commit. " +
    "Best-effort build + tests, single Sonnet gap analysis, <90s target.";

  static override flags = {
    ci: Flags.boolean({
      description: "Machine-readable output for CI pipelines (JSON at the end).",
      default: false,
    }),
    verbose: Flags.boolean({
      description: "Print all soft-audit warnings and full API error bodies.",
      default: false,
    }),
    persist: Flags.boolean({
      description: "Store this checkpoint permanently (no TTL).",
      default: false,
    }),
    week: Flags.integer({
      description: "Week number — defaults to the cohort's current week from `kiln config`.",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Checkpoint);
    try {
      await this.runInner(flags);
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

  private async runInner(flags: {
    ci: boolean;
    verbose: boolean;
    persist: boolean;
    week: number | undefined;
  }): Promise<void> {
    const store = new ConfigStore();
    const config = await store.read();
    const apiUrl = config.apiUrl ?? process.env.KILN_API_URL ?? "http://localhost:4000";
    const token = config.authToken ?? process.env.KILN_TOKEN ?? "";
    const weekNumber = flags.week ?? config.currentWeek ?? 1;

    // ----- Step 1: soft audit --------------------------------------------
    const auditSpinner = p.spinner();
    auditSpinner.start("Running soft-audit");
    const audit = await runSoftAudit(process.cwd());
    auditSpinner.stop(
      audit.hardFailures.length === 0
        ? `Soft-audit passed (${audit.warnings.length} warnings)`
        : `Soft-audit found ${audit.hardFailures.length} hard failure(s)`,
    );

    if (audit.hardFailures.length > 0) {
      for (const hf of audit.hardFailures) {
        this.log(`[HARD] ${hf.name}: ${hf.message}`);
        this.log(`  fix: ${hf.fix}`);
      }
      throw new KilnError("Soft audit found hard failures — cannot create checkpoint.", {
        code: "soft_audit_hard_failures",
        fix: "Resolve the `[HARD]` items above, then rerun `kiln checkpoint`.",
      });
    }

    if (flags.verbose && audit.warnings.length > 0) {
      this.log("\nSoft-audit warnings (non-blocking):");
      for (const w of audit.warnings) {
        this.log(`  • ${w.name}: ${w.message}`);
      }
    }

    // ----- Step 2: git push ----------------------------------------------
    const pushSpinner = p.spinner();
    pushSpinner.start("Pushing HEAD to GitLab");
    let commitSha: string;
    let repoUrl: string;
    try {
      commitSha = (await runGit(["rev-parse", "HEAD"])).trim();
      repoUrl = (await runGit(["config", "--get", "remote.origin.url"])).trim();
      await gitPushHead();
      pushSpinner.stop(`Pushed ${commitSha.slice(0, 8)} to ${redactUrl(repoUrl)}`);
    } catch (err) {
      const msg = redactTokens((err as Error).message);
      pushSpinner.stop(`git push failed: ${msg}`);
      throw new KilnError(`git push failed: ${msg}`, {
        code: "git_push_failed",
        fix: "Set GITLAB_TOKEN (HTTPS) or verify your SSH credentials (`ssh -T git@gitlab.com`). Then rerun `kiln checkpoint`.",
        cause: err,
      });
    }

    // ----- Step 3: POST /api/checkpoints ---------------------------------
    const postSpinner = p.spinner();
    postSpinner.start("Creating checkpoint");
    const createRes = await fetchWithRetry(`${apiUrl}/api/checkpoints`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: token ? `Bearer ${token}` : "",
      },
      body: JSON.stringify({
        repoUrl,
        commitSha,
        weekNumber,
        persist: flags.persist,
      }),
    });
    if (!createRes.ok) {
      postSpinner.stop("Failed to create checkpoint");
      const body = flags.verbose ? await createRes.text() : createRes.statusText;
      throw new KilnError(`checkpoint create rejected: ${createRes.status} ${body}`, {
        code: "checkpoint_create_failed",
        fix: "Check that the current week has checkpoints enabled and that your JWT has cohort scope. Run `kiln admin cohort --id <id> --verbose` or contact your cohort admin.",
      });
    }
    const created = (await createRes.json()) as { checkpointId: string; jobId: string };
    postSpinner.stop(`Checkpoint queued (${created.checkpointId.slice(0, 8)}…)`);

    // ----- Step 4: poll status ------------------------------------------
    const pollSpinner = p.spinner();
    pollSpinner.start("Running checkpoint pipeline (expected <90s)");
    const deadline = Date.now() + 5 * 60 * 1000; // 5-min hard cap
    let done = false;
    let lastStatus = "unknown";
    while (Date.now() < deadline && !done) {
      await sleep(2000);
      let statusRes: Response;
      try {
        statusRes = await fetch(`${apiUrl}/api/status/${created.jobId}`, {
          headers: { authorization: token ? `Bearer ${token}` : "" },
        });
      } catch {
        // Transient failure — keep polling until the deadline.
        continue;
      }
      if (!statusRes.ok) continue;
      const info = (await statusRes.json()) as { status: string };
      lastStatus = info.status;
      if (/COMPLETED/i.test(info.status)) done = true;
      if (/FAILED|CANCELED|TERMINATED/i.test(info.status)) {
        pollSpinner.stop(`Pipeline ${info.status}`);
        throw new KilnError(`Checkpoint pipeline ended with status ${info.status}.`, {
          code: `checkpoint_pipeline_${info.status.toLowerCase()}`,
          fix: "Inspect the worker logs via `kiln logs --job ${jobId}`. Re-run after fixing the root cause (usually docker build, tests, or a prompt error).",
        });
      }
    }
    if (!done) {
      pollSpinner.stop(`Timed out waiting for pipeline (last status: ${lastStatus})`);
      // Temporal timeout is NOT a failure — the checkpoint may still be
      // running in the background. Tell the user how to recover.
      throw new KilnError(
        `Timed out after 5 minutes waiting for checkpoint ${created.checkpointId.slice(0, 8)}… (last status: ${lastStatus}). This is NOT a failure — your checkpoint may still be running.`,
        {
          code: "checkpoint_poll_timeout",
          fix: `Run \`kiln status --job ${created.jobId}\` in a minute to see progress, or \`kiln checkpoint\` again once the previous run finishes.`,
        },
      );
    }
    pollSpinner.stop("Pipeline complete");

    // ----- Step 5: fetch + render report --------------------------------
    const reportRes = await fetchWithRetry(`${apiUrl}/api/checkpoints/${created.checkpointId}`, {
      headers: { authorization: token ? `Bearer ${token}` : "" },
    });
    if (!reportRes.ok) {
      const body = flags.verbose ? await reportRes.text() : reportRes.statusText;
      throw new KilnError(`checkpoint fetch failed: ${reportRes.status} ${body}`, {
        code: "checkpoint_fetch_failed",
        fix: "The pipeline reported complete but the API couldn't serve the stored report. Retry once, then run `kiln doctor`.",
      });
    }
    const payload = (await reportRes.json()) as {
      id: string;
      report: CheckpointReport | null;
      expiresAt: string | null;
    };

    // Partial-evidence edge case: the worker may persist a partially
    // built report if docker build failed but tests + logs + sonar ran.
    // We still render what we have — the user needs to see the gap
    // statuses that made it through.
    if (!payload.report) {
      throw new KilnError(
        "Checkpoint report is missing after pipeline completed — partial evidence persisted without a final report.",
        {
          code: "checkpoint_report_missing",
          fix: "Retry `kiln checkpoint` once. If it happens again, file an issue and attach the workflow id.",
        },
      );
    }

    if (flags.ci) {
      this.log(JSON.stringify({ checkpointId: payload.id, report: payload.report }));
      return;
    }

    renderReport(this, payload.report, payload.expiresAt);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderReport(cmd: Command, report: CheckpointReport, expiresAt: string | null): void {
  const cov = report.evaluation_coverage;
  cmd.log("");
  cmd.log("=== Kiln Checkpoint Report ===");
  cmd.log(
    `Week ${report.week} · ${report.project_key} · overall: ${colorStatus(report.overall_status)}`,
  );
  cmd.log("");
  cmd.log(report.overall_summary);
  cmd.log("");

  cmd.log("Evaluation coverage:");
  cmd.log(`  • docker build: ${cov.docker_build}`);
  cmd.log(`  • tests run:    ${cov.tests_run}`);
  cmd.log(`  • harness logs: ${cov.harness_logs_present ? "present" : "missing"}`);
  cmd.log(`  • sonar:        ${cov.sonar_included ? "included" : "skipped"}`);
  if (cov.notes) cmd.log(`  • notes:        ${cov.notes}`);
  cmd.log("");

  cmd.log("Per-criterion gap status:");
  for (const gap of report.gaps) {
    const score =
      gap.indicative_score === null ? "n/a" : `${gap.indicative_score}/${gap.max_points}`;
    cmd.log(`  ${colorStatus(gap.status).padEnd(14)} ${gap.criterion.padEnd(14)} (${score})`);
    cmd.log(`      ${gap.summary}`);
    for (const rec of gap.recommendations.slice(0, 3)) {
      cmd.log(`      → ${rec}`);
    }
  }
  cmd.log("");

  cmd.log("AI usage snapshot:");
  cmd.log(`  • total_llm_calls: ${report.ai_usage_snapshot.total_llm_calls}`);
  cmd.log(
    `  • sophistication:  ${report.ai_usage_snapshot.sophistication ?? "not yet assessable"}`,
  );
  if (report.ai_usage_snapshot.distinct_tools.length > 0) {
    cmd.log(`  • tools:           ${report.ai_usage_snapshot.distinct_tools.join(", ")}`);
  }
  cmd.log("");

  cmd.log("Top priorities:");
  report.top_priorities.slice(0, 3).forEach((pr, i) => {
    cmd.log(`  ${i + 1}. ${pr.title}${pr.criterion ? ` [${pr.criterion}]` : ""}`);
    cmd.log(`     ${pr.detail}`);
  });
  cmd.log("");

  if (expiresAt) {
    cmd.log(`Expires: ${expiresAt}`);
  } else {
    cmd.log("Expires: persisted (no TTL)");
  }
  cmd.log("");
  cmd.log(
    "These are indicative assessments based on your current progress. Final scores may differ.",
  );
}

function colorStatus(status: string): string {
  // Using ANSI — Clack's own styling lives in its prompt helpers, not in
  // the log sink. Keep this narrow and fail-safe: if the terminal doesn't
  // support color the strings still render.
  const RESET = "\u001b[0m";
  switch (status) {
    case "on-track":
      return `\u001b[32m${status}${RESET}`; // green
    case "at-risk":
      return `\u001b[33m${status}${RESET}`; // yellow
    case "blocked":
      return `\u001b[31m${status}${RESET}`; // red
    case "not-started":
      return `\u001b[90m${status}${RESET}`; // gray
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Git + GitLab push — honours GITLAB_TOKEN without leaking it
// ---------------------------------------------------------------------------

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
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${redactTokens(err)}`));
    });
  });
}

/**
 * Push the current branch HEAD to origin.
 *
 * When GITLAB_TOKEN is set, use `git -c http.extraHeader=PRIVATE-TOKEN: ...`
 * so we never rewrite the remote URL and never leak the token on stdout or
 * in process lists (the arg is visible to root but not to other users —
 * an acceptable trade-off and matches GitLab's own CI recommendation).
 *
 * When GITLAB_TOKEN is NOT set, fall back to whatever credentials git
 * already has (ssh, cached HTTPS).
 */
async function gitPushHead(): Promise<void> {
  const token = process.env.GITLAB_TOKEN;
  const args: string[] = [];
  if (token) {
    args.push("-c", `http.extraHeader=PRIVATE-TOKEN: ${token}`);
  } else {
    // eslint-disable-next-line no-console
    console.warn("[kiln] GITLAB_TOKEN not set — relying on host credentials");
  }
  args.push("push", "origin", "HEAD");
  await runGit(args);
}

function redactTokens(s: string): string {
  const token = process.env.GITLAB_TOKEN;
  if (!token) return s;
  return s.split(token).join("[REDACTED]");
}

function redactUrl(url: string): string {
  // Strip any `user:password@` — even though we no longer rewrite remotes,
  // the origin URL may have been set up by the student with an embedded
  // token. Never print that back.
  return url.replace(/(https?:\/\/)[^/@]+@/, "$1");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
