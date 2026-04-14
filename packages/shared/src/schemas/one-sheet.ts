import { z } from "zod";

export const CitationSchema = z.object({
  kind: z.enum(["file", "commit", "log", "test", "sonar", "url"]),
  ref: z.string(),
  line: z.number().int().nonnegative().optional(),
  excerpt: z.string().optional(),
});

export const SubScoreSchema = z.object({
  key: z.string(),
  awarded_points: z.number(),
  max_points: z.number().nonnegative(),
  rationale: z.string(),
});

export const RubricScoreSchema = z.object({
  criterion: z.string(),
  awarded_points: z.number(),
  max_points: z.number().nonnegative(),
  weight: z.number().min(0).max(1),
  rationale: z.string(),
  citations: z.array(CitationSchema).default([]),
  sub_scores: z.array(SubScoreSchema).default([]),
});

export const TalkingPointSchema = z.object({
  title: z.string(),
  body: z.string(),
  citations: z.array(CitationSchema).default([]),
  severity: z.enum(["info", "praise", "concern", "critical"]).default("info"),
});

export const AiToolUsageSchema = z.object({
  name: z.string(),
  invocations: z.number().int().nonnegative(),
  models: z.array(z.string()).default([]),
  notable_uses: z.array(z.string()).default([]),
});

export const AiUsageAnalysisSchema = z.object({
  tools_used: z.array(AiToolUsageSchema).default([]),
  sophistication: z.enum(["absent", "basic", "intermediate", "advanced", "expert"]),
  sophistication_rationale: z.string(),
  prompt_quality: z.enum(["poor", "adequate", "good", "excellent"]).optional(),
  total_llm_calls: z.number().int().nonnegative().default(0),
  evidence: z.array(CitationSchema).default([]),
});

export const EvaluationCoverageSchema = z.object({
  files_reviewed: z.number().int().nonnegative(),
  files_total: z.number().int().nonnegative(),
  commits_reviewed: z.number().int().nonnegative(),
  commits_total: z.number().int().nonnegative(),
  harness_log_entries_considered: z.number().int().nonnegative(),
  sonar_included: z.boolean(),
  notes: z.string().optional(),
});

export const OneSheetSchema = z.object({
  student_id: z.string(),
  cohort_id: z.string(),
  week: z.number().int().nonnegative(),
  project_key: z.string(),
  rubric_version: z.string(),
  overall_score: z.number(),
  overall_max: z.number().positive(),
  overall_grade: z.string(),
  rubric_scores: z.array(RubricScoreSchema).min(1),
  talking_points: z.array(TalkingPointSchema).default([]),
  ai_usage_analysis: AiUsageAnalysisSchema,
  evaluation_coverage: EvaluationCoverageSchema,
  generated_at: z.string(),
  model: z.string(),
  pipeline_version: z.string(),
});

export type Citation = z.infer<typeof CitationSchema>;
export type RubricScore = z.infer<typeof RubricScoreSchema>;
export type TalkingPoint = z.infer<typeof TalkingPointSchema>;
export type AiUsageAnalysis = z.infer<typeof AiUsageAnalysisSchema>;
export type EvaluationCoverage = z.infer<typeof EvaluationCoverageSchema>;
export type OneSheet = z.infer<typeof OneSheetSchema>;
