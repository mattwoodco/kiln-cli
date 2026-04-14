import Anthropic from "@anthropic-ai/sdk";
import * as p from "@clack/prompts";
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
import { KilnError, formatKilnError, isKilnError } from "../lib/errors.js";
import { KilnApiClient, MOCK_ME, type MeResponse } from "../lib/kiln-api.js";
import { discoverRuntimes, runtimeLabel } from "../lib/runtime-discovery.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

interface AnthropicTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function testAnthropicKey(apiKey: string): Promise<AnthropicTestResult> {
  const client = new Anthropic({ apiKey });
  const started = Date.now();
  try {
    await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchCohortOrMock(
  apiUrl: string,
  token: string | undefined,
  verbose: boolean,
): Promise<{ me: MeResponse; mocked: boolean }> {
  // DEFERRED: Phase 5 API — fall back to mock cohort if unreachable.
  const api = new KilnApiClient(apiUrl, token);
  try {
    const reachable = await api.pingWithTimeout(1500);
    if (!reachable) {
      if (verbose) p.log.warn(`Kiln API at ${apiUrl} unreachable — using mock cohort.`);
      return { me: MOCK_ME, mocked: true };
    }
    const me = await api.me();
    return { me, mocked: false };
  } catch (err) {
    if (verbose) {
      p.log.warn(
        `Kiln API call failed (${err instanceof Error ? err.message : String(err)}) — using mock cohort.`,
      );
    }
    return { me: MOCK_ME, mocked: true };
  }
}

function renderCheck(c: CheckResult): string {
  const icon = c.status === "ok" ? "OK" : c.status === "warn" ? "WARN" : "FAIL";
  return `[${icon}] ${c.name}: ${c.detail}`;
}

export default class Init extends Command {
  static override description =
    "Initialize the Kiln CLI: verify host tooling, record credentials, and fetch cohort assignment.";

  static override examples = [
    "$ kiln init",
    "$ kiln init --ci --token $KILN_TOKEN",
    "$ kiln init --reset",
  ];

  static override flags = {
    ci: Flags.boolean({ description: "Non-interactive mode for CI environments." }),
    token: Flags.string({ description: "JWT auth token for the Kiln API." }),
    reset: Flags.boolean({ description: "Wipe existing ~/.kiln/config.json before init." }),
    verbose: Flags.boolean({ description: "Verbose output (per-check details)." }),
    "api-url": Flags.string({
      description: "Kiln API base URL.",
      default: process.env.KILN_API_URL ?? "http://localhost:4000",
      env: "KILN_API_URL",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Init);
    const verbose = flags.verbose === true;
    const ci = flags.ci === true;

    try {
      const store = new ConfigStore();
      if (flags.reset && (await store.exists())) {
        if (verbose) p.log.info(`Removing existing config at ${store.path}`);
        const { rm } = await import("node:fs/promises");
        await rm(store.path);
      }

      if (!ci) p.intro("kiln init");
      else this.log("kiln init (ci mode)");

      // 1. Host checks.
      const checks: CheckResult[] = [
        await checkDocker(),
        await checkDockerCompose(),
        await checkGit(),
        await checkBun(),
      ];
      const containerRuntime = await detectContainerRuntime();

      const failures = checks.filter((c) => c.status === "fail");
      for (const c of checks) {
        if (verbose || c.status !== "ok") {
          this.log(renderCheck(c));
          if (c.fix && c.status !== "ok") this.log(`     fix: ${c.fix}`);
        }
      }
      if (verbose) this.log(`[INFO] container runtime: ${containerRuntime}`);
      if (failures.length > 0) {
        throw new KilnError(`Host checks failed: ${failures.map((f) => f.name).join(", ")}`, {
          fix: failures
            .map((f) => f.fix ?? "see above")
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(" | "),
          code: "HOST_CHECKS",
        });
      }

      // 2. Runtime discovery in CWD.
      const runtimes = await discoverRuntimes(process.cwd());
      if (runtimes.length > 0) {
        this.log("Detected project runtimes:");
        for (const r of runtimes) {
          const ok = r.satisfies ? "OK" : "WARN";
          const want = r.declaredVersion ?? r.minVersion;
          this.log(
            `  [${ok}] ${runtimeLabel(r.runtime)}: ${r.installedVersion ?? "not installed"} (want ≥${want})`,
          );
          if (!r.satisfies && r.fix) this.log(`       fix: ${r.fix}`);
        }
      }

      // 3. Credentials.
      const existing = await store.read();
      let anthropicKey: string | undefined = existing.anthropicKey;
      let openaiKey: string | undefined = existing.openaiKey;
      let googleKey: string | undefined = existing.googleKey;

      if (ci) {
        anthropicKey = process.env.ANTHROPIC_API_KEY ?? anthropicKey;
        openaiKey = process.env.OPENAI_API_KEY ?? openaiKey;
        googleKey = process.env.GOOGLE_AI_KEY ?? googleKey;
        if (!anthropicKey) {
          throw new KilnError("--ci requires ANTHROPIC_API_KEY in the environment.", {
            fix: "export ANTHROPIC_API_KEY=sk-ant-... before re-running.",
            code: "CI_NO_KEY",
          });
        }
      } else {
        const ak = await p.password({
          message: "ANTHROPIC_API_KEY",
          validate(value) {
            if (!value) return "Required.";
            if (!value.startsWith("sk-ant-")) return "Expected sk-ant-... prefix.";
            return undefined;
          },
        });
        if (p.isCancel(ak)) throw new KilnError("Cancelled.", { fix: "Re-run kiln init." });
        anthropicKey = ak as string;

        const addOpenAI = await p.confirm({ message: "Add OPENAI_API_KEY?", initialValue: false });
        if (p.isCancel(addOpenAI)) throw new KilnError("Cancelled.", { fix: "Re-run kiln init." });
        if (addOpenAI) {
          const v = await p.password({ message: "OPENAI_API_KEY" });
          if (p.isCancel(v)) throw new KilnError("Cancelled.", { fix: "Re-run kiln init." });
          openaiKey = v as string;
        }

        const addGoogle = await p.confirm({ message: "Add GOOGLE_AI_KEY?", initialValue: false });
        if (p.isCancel(addGoogle)) throw new KilnError("Cancelled.", { fix: "Re-run kiln init." });
        if (addGoogle) {
          const v = await p.password({ message: "GOOGLE_AI_KEY" });
          if (p.isCancel(v)) throw new KilnError("Cancelled.", { fix: "Re-run kiln init." });
          googleKey = v as string;
        }
      }

      // 4. Live Anthropic test call.
      const spin = ci ? undefined : p.spinner();
      spin?.start(`Testing Anthropic ${HAIKU_MODEL}`);
      const testResult = await testAnthropicKey(anthropicKey ?? "");
      if (testResult.ok) {
        spin?.stop(`Anthropic OK (${testResult.latencyMs}ms)`);
        if (ci) this.log(`[OK] anthropic test call: ${testResult.latencyMs}ms`);
      } else {
        spin?.stop("Anthropic test call failed");
        throw new KilnError(`Anthropic test call failed: ${testResult.error ?? "unknown"}`, {
          fix: "Verify your ANTHROPIC_API_KEY at https://console.anthropic.com/settings/keys.",
          code: "ANTHROPIC_TEST",
        });
      }

      // 5. Kiln API authentication + cohort.
      const token = flags.token ?? existing.authToken;
      const { me, mocked } = await fetchCohortOrMock(flags["api-url"], token, verbose);
      if (mocked) {
        this.log(
          `[WARN] Kiln API unreachable at ${flags["api-url"]} — using mock cohort '${me.cohortName}' (week ${me.currentWeek}).`,
        );
      } else {
        this.log(`Cohort: ${me.cohortName} (${me.cohortId}), week ${me.currentWeek}`);
      }

      // 6. Write config.
      await store.write({
        version: "v1",
        anthropicKey,
        openaiKey,
        googleKey,
        authToken: token,
        cohortId: me.cohortId,
        cohortName: me.cohortName,
        currentWeek: me.currentWeek,
        containerRuntime,
        apiUrl: flags["api-url"],
      });

      if (!ci) p.outro(`Wrote ${store.path}`);
      else this.log(`[OK] wrote ${store.path}`);
    } catch (err) {
      if (isKilnError(err)) {
        this.log(formatKilnError(err));
        this.exit(1);
      }
      throw err;
    }
  }
}
