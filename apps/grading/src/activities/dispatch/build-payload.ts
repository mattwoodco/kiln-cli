/**
 * Phase 7.5 — build-payload activity.
 *
 * Assembles the artifact subset requested by `target.artifactSelectors`,
 * runs an optional dotted-path transform template, and returns a
 * `{ payload, payloadBytes, sizeCapped }` tuple.
 *
 * Selector → source:
 *   one_sheet     → grading_results.one_sheet (jsonb)
 *   logs_summary  → first 50 lines of `harness-log-summary.json` artifact
 *                   (falls back to whatever's at the submission dir, else null)
 *   sonar_metrics → grading_results.sonar_metrics (jsonb)
 *   ai_usage      → projection over pipeline_usage_events.llm_calls
 *   raw_archive   → inline base64 tar if <2MB, else signed URL reference
 *                   (DEFERRED: real signed URLs — uses kiln.local stub)
 *
 * Size cap: if the assembled payload exceeds 2 MB, `raw_archive` is replaced
 * with `{ kind: "signed_url", url: "https://kiln.local/artifacts/<sub>/raw" }`
 * and the payload is rebuilt.
 *
 * Transform template: a JSON object mapping output keys to dotted paths
 * into the assembled selectors object. We use a SAFE dotted-path resolver,
 * NEVER `eval`. DEFERRED: full JSONata.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactSelector, LLMCallDetail } from "@kiln/shared";
import { eq } from "drizzle-orm";
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../../db/schema.js";
import { redactPayload } from "./redact-payload.js";

type DispatchDb = NodePgDatabase<typeof schema>;

let cachedPool: pg.Pool | null = null;
let cachedDb: DispatchDb | null = null;

function getDb(): DispatchDb {
  if (cachedDb) return cachedDb;
  const connectionString = process.env.DATABASE_URL ?? "postgres://kiln:kiln@localhost:5432/kiln";
  cachedPool = new pg.Pool({ connectionString, max: 4 });
  cachedDb = drizzle(cachedPool, { schema });
  return cachedDb;
}

const SIZE_CAP_BYTES = 2 * 1024 * 1024; // 2 MB

export interface BuildPayloadInput {
  submissionId: string;
  cohortId: string;
  selectors: ArtifactSelector[];
  transformTemplate: string | null;
}

export interface BuildPayloadResult {
  payload: unknown;
  payloadBytes: number;
  sizeCapped: boolean;
}

interface AssembledArtifacts {
  one_sheet?: unknown;
  logs_summary?: unknown;
  sonar_metrics?: unknown;
  ai_usage?: unknown;
  raw_archive?: unknown;
  // Carried for response-shaping helpers like Portal target.
  student_id?: string | null;
  submission_id?: string;
  rubric_version?: string | null;
}

function artifactDir(cohortId: string, submissionId: string): string {
  const base = process.env.STORAGE_PATH ?? "./data";
  return path.join(base, "cohorts", cohortId, "submissions", submissionId);
}

async function readJsonIfExists(fp: string): Promise<unknown | null> {
  try {
    const txt = await readFile(fp, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

interface AiUsageProjection {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cache_hit_rate: number;
  calls_by_purpose: Record<string, number>;
}

function projectAiUsage(calls: LLMCallDetail[]): AiUsageProjection {
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let cacheRead = 0;
  const byPurpose: Record<string, number> = {};
  for (const c of calls) {
    totalCost += c.estimated_cost_usd;
    totalInput += c.input_tokens;
    totalOutput += c.output_tokens;
    cacheRead += c.cache_read_tokens;
    byPurpose[c.purpose] = (byPurpose[c.purpose] ?? 0) + 1;
  }
  const cacheHitRate = totalInput + cacheRead > 0 ? cacheRead / (totalInput + cacheRead) : 0;
  return {
    total_cost_usd: Number(totalCost.toFixed(6)),
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    cache_hit_rate: Number(cacheHitRate.toFixed(4)),
    calls_by_purpose: byPurpose,
  };
}

/**
 * Walks a dotted path into an arbitrary value. Supports `a.b.c` and never
 * uses `eval`. Returns `undefined` for any missing segment.
 */
export function dottedGet(value: unknown, dotted: string): unknown {
  if (!dotted) return value;
  const parts = dotted.split(".");
  let cur: unknown = value;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Apply a transform template. The template is a JSON object whose values
 * are dotted paths into the assembled artifact bundle. Example:
 *   { "score": "one_sheet.overall_score", "ai": "ai_usage.total_cost_usd" }
 *
 * If parsing fails or the template is empty, returns the raw input.
 */
export function applyTransform(input: unknown, templateJson: string | null): unknown {
  if (!templateJson) return input;
  let template: unknown;
  try {
    template = JSON.parse(templateJson);
  } catch {
    return input;
  }
  if (!template || typeof template !== "object" || Array.isArray(template)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = dottedGet(input, v);
    } else if (v && typeof v === "object") {
      // Allow nested literal objects passthrough.
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function assembleArtifacts(input: BuildPayloadInput): Promise<{
  artifacts: AssembledArtifacts;
  cohortIdFromDb: string | null;
  userIdFromDb: string | null;
  rubricVersion: string | null;
}> {
  const db = getDb();
  const dir = artifactDir(input.cohortId, input.submissionId);
  const out: AssembledArtifacts = {
    submission_id: input.submissionId,
  };

  // Load grading_results row if any selector needs it.
  const needsGrading =
    input.selectors.includes("one_sheet") || input.selectors.includes("sonar_metrics");
  let gradingRow: typeof schema.gradingResults.$inferSelect | null = null;
  if (needsGrading) {
    const [row] = await db
      .select()
      .from(schema.gradingResults)
      .where(eq(schema.gradingResults.submissionId, input.submissionId))
      .limit(1);
    gradingRow = row ?? null;
  }

  if (input.selectors.includes("one_sheet")) {
    out.one_sheet = gradingRow?.oneSheet ?? null;
  }
  if (input.selectors.includes("sonar_metrics")) {
    out.sonar_metrics = gradingRow?.sonarMetrics ?? null;
  }
  out.rubric_version = gradingRow?.rubricVersion ?? null;

  // Submission row → student_id
  const [sub] = await db
    .select()
    .from(schema.submissions)
    .where(eq(schema.submissions.id, input.submissionId))
    .limit(1);
  out.student_id = sub?.userId ?? undefined;

  if (input.selectors.includes("logs_summary")) {
    const fp = path.join(dir, "harness-log-summary.json");
    const json = await readJsonIfExists(fp);
    if (json && typeof json === "object") {
      out.logs_summary = json;
    } else {
      // Fall back to first 50 lines of any *.jsonl in submission dir.
      out.logs_summary = { entries: [], note: "no_logs_summary_artifact" };
    }
  }

  if (input.selectors.includes("ai_usage")) {
    const usageRows = await db
      .select()
      .from(schema.pipelineUsageEvents)
      .where(eq(schema.pipelineUsageEvents.submissionId, input.submissionId));
    const allCalls: LLMCallDetail[] = [];
    for (const u of usageRows) {
      const calls = (u.llmCalls ?? []) as LLMCallDetail[];
      for (const c of calls) allCalls.push(c);
    }
    out.ai_usage = projectAiUsage(allCalls);
  }

  if (input.selectors.includes("raw_archive")) {
    // DEFERRED: real tar + signed URL. Inline a compact JSON listing for
    // small submissions, replace with stub URL when over cap.
    try {
      const stats = await stat(dir);
      if (stats.isDirectory()) {
        out.raw_archive = {
          kind: "inline",
          path: dir,
          note: "DEFERRED: tar+base64 not yet implemented (Phase 7.5 stub)",
        };
      }
    } catch {
      out.raw_archive = { kind: "missing" };
    }
  }

  return {
    artifacts: out,
    cohortIdFromDb: input.cohortId,
    userIdFromDb: sub?.userId ?? null,
    rubricVersion: gradingRow?.rubricVersion ?? null,
  };
}

export async function buildPayload(input: BuildPayloadInput): Promise<BuildPayloadResult> {
  const { artifacts } = await assembleArtifacts(input);

  // Initial assemble + size check.
  let transformed = applyTransform(artifacts, input.transformTemplate);
  let redacted = redactPayload(transformed);
  let bytes = Buffer.byteLength(JSON.stringify(redacted));
  let sizeCapped = false;

  if (bytes > SIZE_CAP_BYTES && input.selectors.includes("raw_archive")) {
    sizeCapped = true;
    artifacts.raw_archive = {
      kind: "signed_url",
      url: `https://kiln.local/artifacts/${input.submissionId}/raw`,
      note: "DEFERRED: real signed URL — Phase 7.5 stub",
    };
    transformed = applyTransform(artifacts, input.transformTemplate);
    redacted = redactPayload(transformed);
    bytes = Buffer.byteLength(JSON.stringify(redacted));
  }

  return {
    payload: redacted,
    payloadBytes: bytes,
    sizeCapped,
  };
}
