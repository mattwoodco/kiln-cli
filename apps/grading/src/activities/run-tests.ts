import type { ChaosResult } from "@kiln/shared";
import yaml from "js-yaml";
import type { RunTestsInput, RunTestsResult } from "./types.js";

/**
 * DEFERRED: real Pumba / Toxiproxy wiring. Phase 4 (chaos harness) lands
 * the actual fault injection; for Phase 5 we stub this activity with a
 * deterministic simulation so the rest of the pipeline is runnable and
 * testable end-to-end.
 *
 * The simulation:
 *  - Parses the visible chaos YAML and emits one ChaosResult per
 *    experiment, all marked PASS by default (pretending the student's
 *    service held steady).
 *  - On stage="final" (AND only then), parses the hidden chaos YAML and
 *    emits a parallel set of results.
 *  - On stage="early", hidden is `null`.
 *  - If the build status is "missing" or "failed", all chaos results
 *    collapse to verdict "FAIL" with note "build_unavailable".
 */

const ChaosExperimentIdx = {
  parseMany(text: string, kind: "visible" | "hidden"): ChaosResult[] {
    if (!text || text.trim() === "") return [];
    let doc: unknown;
    try {
      doc = yaml.load(text);
    } catch {
      return [];
    }
    if (!doc || typeof doc !== "object") return [];
    const maybe = doc as { experiments?: unknown };
    if (!Array.isArray(maybe.experiments)) return [];
    const out: ChaosResult[] = [];
    const now = new Date().toISOString();
    for (const raw of maybe.experiments) {
      if (!raw || typeof raw !== "object") continue;
      const exp = raw as {
        id?: unknown;
        fault?: { kind?: unknown; target?: unknown; parameters?: unknown };
      };
      const id =
        typeof exp.id === "string" ? exp.id : `exp-${Math.random().toString(36).slice(2, 8)}`;
      const fault = exp.fault && typeof exp.fault === "object" ? exp.fault : {};
      const faultKind = typeof fault.kind === "string" ? fault.kind : "latency";
      const target = typeof fault.target === "string" ? fault.target : "service";
      const params =
        fault.parameters && typeof fault.parameters === "object"
          ? (fault.parameters as Record<string, unknown>)
          : {};
      out.push({
        experiment_id: id,
        fault: {
          kind: faultKind as ChaosResult["fault"]["kind"],
          target,
          parameters: params,
        },
        steady_state_pre: {
          checked_at: now,
          passed: true,
          metrics: {},
        },
        steady_state_post: {
          checked_at: now,
          passed: true,
          metrics: {},
        },
        verdict: "PASS",
        started_at: now,
        duration_ms: 250,
        profile_kind: kind,
        observations: ["stub_simulation_phase5"],
      });
    }
    return out;
  },
};

export async function runTests(input: RunTestsInput): Promise<RunTestsResult> {
  let visible = ChaosExperimentIdx.parseMany(input.visibleChaosYaml, "visible");
  let hidden: ChaosResult[] | null =
    input.stage === "final" ? ChaosExperimentIdx.parseMany(input.hiddenChaosYaml, "hidden") : null;

  if (input.buildStatus === "missing" || input.buildStatus === "failed") {
    const collapse = (arr: ChaosResult[]): ChaosResult[] =>
      arr.map((r) => ({
        ...r,
        verdict: "FAIL" as const,
        observations: [...r.observations, "build_unavailable"],
        steady_state_post: { ...r.steady_state_post, passed: false },
      }));
    visible = collapse(visible);
    if (hidden) hidden = collapse(hidden);
  }

  return {
    visible,
    hidden,
    testSuitesPassed: 0,
    testSuitesFailed: input.buildStatus === "ok" ? 0 : 1,
  };
}
