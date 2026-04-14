import { z } from "zod";
import { RubricSchema } from "./rubric.js";

export const ProjectTemplateSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  starter_repo_url: z.string().url().optional(),
  rubric_key: z.string(),
  rubric_version: z.string(),
  artifacts_expected: z.array(z.string()).default([]),
});

export const WeekConfigSchema = z.object({
  week: z.number().int().nonnegative(),
  project_key: z.string(),
  rubric: RubricSchema.optional(),
  rubric_key: z.string().optional(),
  rubric_version: z.string().optional(),
  checkpoints: z
    .array(
      z.object({
        day: z.number().int().min(1).max(7),
        kind: z.enum(["mid-week", "eod", "friday"]).default("mid-week"),
      }),
    )
    .default([]),
  starts_at: z.string(),
  ends_at: z.string(),
});

export const CohortSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  students: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().email(),
        gitlab_username: z.string().optional(),
      }),
    )
    .default([]),
  weeks: z.array(WeekConfigSchema).default([]),
  project_templates: z.array(ProjectTemplateSchema).default([]),
});

export type ProjectTemplate = z.infer<typeof ProjectTemplateSchema>;
export type WeekConfig = z.infer<typeof WeekConfigSchema>;
export type Cohort = z.infer<typeof CohortSchema>;
