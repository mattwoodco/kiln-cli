import { z } from "zod";

export const SonarRatingSchema = z.enum(["A", "B", "C", "D", "E"]);

export const SonarMetricsSchema = z.object({
  project_key: z.string(),
  analyzed_at: z.string(),
  complexity: z.number().nonnegative(),
  cognitive_complexity: z.number().nonnegative().optional(),
  duplication_pct: z.number().min(0).max(100),
  code_smells: z.number().int().nonnegative(),
  bugs: z.number().int().nonnegative(),
  vulnerabilities: z.number().int().nonnegative(),
  security_hotspots: z.number().int().nonnegative().optional(),
  coverage_pct: z.number().min(0).max(100),
  lines_of_code: z.number().int().nonnegative().optional(),
  sqale_rating: SonarRatingSchema,
  maintainability_rating: SonarRatingSchema,
  reliability_rating: SonarRatingSchema.optional(),
  security_rating: SonarRatingSchema.optional(),
  raw: z.unknown().optional(),
});

export type SonarRating = z.infer<typeof SonarRatingSchema>;
export type SonarMetrics = z.infer<typeof SonarMetricsSchema>;
