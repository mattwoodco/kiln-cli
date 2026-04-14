/**
 * Common helpers for chaos commands: ChaosResult construction,
 * steady-state → schema marshaling, and writing results to
 * `.kiln/chaos-results/${timestamp}.json`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ChaosFault,
  type ChaosResult,
  ChaosResultSchema,
  type ChaosVerdict,
  type SteadyState,
} from "@kiln/shared";
import type { SteadyStateRunResult } from "./steady-state.js";

export function steadyStateToSchema(run: SteadyStateRunResult): SteadyState {
  const metrics: Record<string, unknown> = {
    verdict: run.verdict,
    results: run.results,
  };
  return {
    checked_at: run.checkedAt,
    passed: run.verdict === "PASS",
    metrics,
  };
}

/** Combine pre- and post-experiment verdicts into a single ChaosVerdict. */
export function deriveOverallVerdict(
  pre: SteadyStateRunResult | null,
  post: SteadyStateRunResult | null,
): ChaosVerdict {
  if (!pre && !post) return "PASS";
  if (pre && pre.verdict === "FAIL") return "FAIL";
  if (post) {
    if (post.verdict === "FAIL") return "FAIL";
    if (post.verdict === "DEGRADED") return "DEGRADED";
  }
  return "PASS";
}

export interface BuildChaosResultInput {
  experimentId: string;
  fault: ChaosFault;
  startedAt: string;
  durationMs: number;
  pre?: SteadyStateRunResult | null;
  post?: SteadyStateRunResult | null;
  verdict?: ChaosVerdict;
  profileKind?: "visible" | "hidden";
  observations?: string[];
}

export function buildChaosResult(input: BuildChaosResultInput): ChaosResult {
  const now = new Date().toISOString();
  const preSs =
    input.pre !== undefined && input.pre !== null
      ? steadyStateToSchema(input.pre)
      : { checked_at: now, passed: true, metrics: { verdict: "PASS" } };
  const postSs =
    input.post !== undefined && input.post !== null
      ? steadyStateToSchema(input.post)
      : { checked_at: now, passed: true, metrics: { verdict: "PASS" } };
  const verdict = input.verdict ?? deriveOverallVerdict(input.pre ?? null, input.post ?? null);
  const result: ChaosResult = {
    experiment_id: input.experimentId,
    fault: input.fault,
    steady_state_pre: preSs,
    steady_state_post: postSs,
    verdict,
    started_at: input.startedAt,
    duration_ms: input.durationMs,
    profile_kind: input.profileKind,
    observations: input.observations ?? [],
  };
  return ChaosResultSchema.parse(result);
}

export async function writeChaosResultFile(
  projectDir: string,
  result: ChaosResult,
): Promise<string> {
  const outDir = join(projectDir, ".kiln", "chaos-results");
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${result.experiment_id}.json`;
  const filePath = join(outDir, filename);
  await writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return filePath;
}

export function makeExperimentId(kind: string): string {
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
