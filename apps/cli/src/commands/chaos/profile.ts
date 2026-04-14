import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChaosFaultKind, ChaosResult } from "@kiln/shared";
import { Command, Flags } from "@oclif/core";
import { Pumba } from "../../lib/chaos/pumba.js";
import {
  buildChaosResult,
  makeExperimentId,
  writeChaosResultFile,
} from "../../lib/chaos/result-writer.js";
import { runSteadyState } from "../../lib/chaos/steady-state.js";
import { parseYamlSubset } from "../../lib/chaos/steady-state.js";
import { ToxiproxyClient } from "../../lib/chaos/toxiproxy.js";
import { KilnError, formatKilnError, isKilnError } from "../../lib/errors.js";

/**
 * Shape of a week chaos profile file. Supports a `sequence` array where
 * each entry declares the kind of fault and a handful of parameters.
 *
 *   experiments:
 *     - kind: latency
 *       target: api
 *       delay_ms: 500
 *       jitter_ms: 100
 *       duration_seconds: 5
 *     - kind: disconnect
 *       target: api
 *       duration_seconds: 3
 *     - kind: kill
 *       target: worker
 *     - kind: stress
 *       target: api
 *       cpu: 2
 *       duration_seconds: 4
 */
type ParsedValue = string | number | boolean | null | ParsedValue[] | { [k: string]: ParsedValue };

function isRecord(v: unknown): v is Record<string, ParsedValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface ProfileStep {
  kind: "latency" | "disconnect" | "kill" | "stress" | "pause";
  target: string;
  params: Record<string, number | string>;
}

function readNumber(entry: Record<string, ParsedValue>, key: string): number | undefined {
  const v = entry[key];
  return typeof v === "number" ? v : undefined;
}

function parseProfile(raw: string): ProfileStep[] {
  const parsed = parseYamlSubset(raw);
  if (!isRecord(parsed)) return [];
  const list = parsed.experiments ?? parsed.sequence ?? [];
  if (!Array.isArray(list)) return [];
  const out: ProfileStep[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const kindRaw = typeof item.kind === "string" ? item.kind : undefined;
    const target = typeof item.target === "string" ? item.target : undefined;
    if (!kindRaw || !target) continue;
    if (
      kindRaw !== "latency" &&
      kindRaw !== "disconnect" &&
      kindRaw !== "kill" &&
      kindRaw !== "stress" &&
      kindRaw !== "pause"
    ) {
      continue;
    }
    const params: Record<string, number | string> = {};
    for (const k of ["delay_ms", "jitter_ms", "duration_seconds", "cpu", "in_seconds"] as const) {
      const n = readNumber(item, k);
      if (n !== undefined) params[k] = n;
    }
    out.push({ kind: kindRaw, target, params });
  }
  return out;
}

function faultKindFor(step: ProfileStep): ChaosFaultKind {
  switch (step.kind) {
    case "latency":
      return "latency";
    case "disconnect":
      return "disconnect";
    case "kill":
      return "drop";
    case "stress":
      return "rate_limit";
    case "pause":
      return "rate_limit";
  }
}

export default class ChaosProfile extends Command {
  static override description =
    "Run the visible chaos profile for a given week. (Hidden profiles stay server-side.)";

  static override examples = [
    "$ kiln chaos profile --week 1",
    "$ kiln chaos profile --week 2 --ci",
  ];

  static override flags = {
    week: Flags.integer({ description: "Week number", required: true }),
    ci: Flags.boolean({ description: "Machine-readable JSON output" }),
    verbose: Flags.boolean({ description: "Verbose logging" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ChaosProfile);
    const cwd = process.cwd();

    try {
      const padded = String(flags.week).padStart(2, "0");
      const profilePath = join(cwd, ".kiln", "chaos-profiles", `week-${padded}.yml`);
      const legacyPath = join(cwd, ".kiln", "chaos-profiles", `week-${flags.week}.yml`);
      const pathToRead = existsSync(profilePath)
        ? profilePath
        : existsSync(legacyPath)
          ? legacyPath
          : null;

      if (!pathToRead) {
        throw new KilnError(`No chaos profile for week ${flags.week} at ${profilePath}`, {
          fix: `kiln scaffold --week ${flags.week}  (add --adopt for brownfield)`,
          code: "CHAOS_PROFILE_MISSING",
        });
      }

      if (flags.verbose) this.log(`[profile] reading ${pathToRead}`);
      const raw = await readFile(pathToRead, "utf8");
      const steps = parseProfile(raw);
      if (steps.length === 0) {
        throw new KilnError(`Chaos profile ${pathToRead} has no experiments`, {
          fix: "Add at least one entry under `experiments:` following the template format.",
          code: "CHAOS_PROFILE_EMPTY",
        });
      }

      const toxi = new ToxiproxyClient();
      const pumba = new Pumba();

      // Always run steady-state before the sequence.
      if (flags.verbose) this.log("[profile] steady-state pre");
      const pre = await runSteadyState({ projectDir: cwd }).catch((err) => {
        if (flags.verbose) this.log(`[profile] pre steady-state errored: ${String(err)}`);
        return null;
      });

      const results: ChaosResult[] = [];
      for (const step of steps) {
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        const observations: string[] = [];
        try {
          if (step.kind === "latency") {
            const delay = Number(step.params.delay_ms ?? 200);
            const jitter = Number(step.params.jitter_ms ?? 0);
            const duration = Number(step.params.duration_seconds ?? 5);
            await toxi.addLatency(step.target, delay, jitter);
            await new Promise<void>((r) => setTimeout(r, duration * 1000));
            await toxi.removeAll();
            observations.push(`latency ${delay}ms +/- ${jitter}ms for ${duration}s`);
          } else if (step.kind === "disconnect") {
            const duration = Number(step.params.duration_seconds ?? 5);
            await toxi.addDisconnect(step.target, duration);
            observations.push(`disconnected for ${duration}s`);
          } else if (step.kind === "kill") {
            const inSeconds = Number(step.params.in_seconds ?? 0);
            await pumba.killContainer(step.target, { inSeconds });
            observations.push(`killed after ${inSeconds}s`);
          } else if (step.kind === "stress") {
            const cpu = Number(step.params.cpu ?? 1);
            const duration = Number(step.params.duration_seconds ?? 5);
            await pumba.stressContainer(step.target, cpu, duration);
            observations.push(`stressed ${cpu} cpu for ${duration}s`);
          } else if (step.kind === "pause") {
            const duration = Number(step.params.duration_seconds ?? 5);
            await pumba.pauseContainer(step.target, duration);
            observations.push(`paused for ${duration}s`);
          }
        } catch (err) {
          observations.push(`error: ${err instanceof Error ? err.message : String(err)}`);
        }
        results.push(
          buildChaosResult({
            experimentId: makeExperimentId(`profile-${step.kind}`),
            fault: {
              kind: faultKindFor(step),
              target: step.target,
              parameters: step.params,
            },
            startedAt,
            durationMs: Date.now() - startMs,
            profileKind: "visible",
            observations,
          }),
        );
      }

      // Steady-state post.
      if (flags.verbose) this.log("[profile] steady-state post");
      const post = await runSteadyState({ projectDir: cwd }).catch(() => null);

      // Attach the overall pre/post to the final synthetic result.
      const overall = buildChaosResult({
        experimentId: makeExperimentId("profile"),
        fault: {
          kind: "latency",
          target: "profile-aggregate",
          parameters: { week: flags.week, steps: steps.length },
        },
        startedAt: new Date().toISOString(),
        durationMs: 0,
        pre,
        post,
        profileKind: "visible",
        observations: ["profile_kind: visible (hidden set is server-side only)"],
      });
      results.push(overall);

      for (const r of results) {
        await writeChaosResultFile(cwd, r);
      }

      if (flags.ci) {
        this.log(JSON.stringify({ profile_kind: "visible", results }, null, 2));
      } else {
        this.log(`[profile] week ${flags.week} — ${steps.length} step(s) (visible)`);
        this.log(
          "[profile] NOTE: the grader additionally runs an unseen hidden set on final submission.",
        );
        for (const r of results) {
          this.log(`  ${r.verdict}  ${r.fault.kind}  target=${r.fault.target}`);
        }
      }
      if (results.some((r) => r.verdict === "FAIL")) this.exit(1);
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
