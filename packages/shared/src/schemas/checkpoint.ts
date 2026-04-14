import { z } from "zod";
import { CitationSchema } from "./one-sheet.js";

// ---------------------------------------------------------------------------
// Checkpoint reports
//
// A checkpoint is a mid-week, formative snapshot. Unlike a grading one-sheet,
// scores are *indicative* and may be `null` when evidence is missing. The
// schema explicitly models the "we couldn't assess this" state so the LLM
// is forced to admit gaps rather than guess.
// ---------------------------------------------------------------------------

export const CheckpointStatusSchema = z.enum(["on-track", "at-risk", "not-started", "blocked"]);

export const CheckpointGapSchema = z.object({
  criterion: z.string(),
  status: CheckpointStatusSchema,
  /** Indicative score — nullable when evidence is insufficient. */
  indicative_score: z.number().nullable(),
  max_points: z.number().nonnegative(),
  recommendations: z.array(z.string()).default([]),
  evidence: z.array(CitationSchema).default([]),
  summary: z.string(),
});

/**
 * What the pipeline could and could not inspect. Every field is required so
 * the renderer can honestly explain evaluation coverage to the student.
 */
export const CheckpointEvaluationCoverageSchema = z.object({
  docker_build: z.enum(["ok", "failed", "missing", "skipped"]),
  tests_run: z.enum(["ok", "failed", "missing", "skipped"]),
  harness_logs_present: z.boolean(),
  sonar_included: z.boolean(),
  files_considered: z.number().int().nonnegative(),
  notes: z.string().optional(),
});

/**
 * Minimal AI usage snapshot — subset of `AiUsageAnalysis` from the full
 * one-sheet. Checkpoints do not drill into prompt quality or evidence
 * citations, just the headline numbers.
 */
export const CheckpointAiUsageSnapshotSchema = z.object({
  total_llm_calls: z.number().int().nonnegative().default(0),
  distinct_tools: z.array(z.string()).default([]),
  sophistication: z
    .enum(["absent", "basic", "intermediate", "advanced", "expert"])
    .nullable()
    .default(null),
  notes: z.string().optional(),
});

export const CheckpointPrioritySchema = z.object({
  title: z.string(),
  detail: z.string(),
  criterion: z.string().optional(),
});

export const CheckpointReportSchema = z.object({
  student_id: z.string(),
  cohort_id: z.string(),
  week: z.number().int().nonnegative(),
  project_key: z.string(),
  checkpoint_kind: z.enum(["mid-week", "eod", "friday"]).default("mid-week"),
  generated_at: z.string(),
  /** Overall status across all rubric criteria. */
  overall_status: CheckpointStatusSchema,
  overall_summary: z.string(),
  gaps: z.array(CheckpointGapSchema),
  evaluation_coverage: CheckpointEvaluationCoverageSchema,
  ai_usage_snapshot: CheckpointAiUsageSnapshotSchema,
  top_priorities: z.array(CheckpointPrioritySchema).max(5).default([]),
  commits_considered: z.number().int().nonnegative().default(0),
  harness_entries_considered: z.number().int().nonnegative().default(0),
  model: z.string(),
  pipeline_version: z.string(),
});

export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;
export type CheckpointGap = z.infer<typeof CheckpointGapSchema>;
export type CheckpointEvaluationCoverage = z.infer<typeof CheckpointEvaluationCoverageSchema>;
export type CheckpointAiUsageSnapshot = z.infer<typeof CheckpointAiUsageSnapshotSchema>;
export type CheckpointPriority = z.infer<typeof CheckpointPrioritySchema>;
export type CheckpointReport = z.infer<typeof CheckpointReportSchema>;
