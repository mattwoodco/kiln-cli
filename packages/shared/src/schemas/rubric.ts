import { z } from "zod";

export const SubCriterionSchema = z.object({
  key: z.string(),
  label: z.string(),
  max_points: z.number().nonnegative(),
  description: z.string().optional(),
});

export const RubricCriterionSchema = z.object({
  key: z.string(),
  label: z.string(),
  weight: z.number().min(0).max(1),
  max_points: z.number().nonnegative(),
  description: z.string().optional(),
  sub_criteria: z.array(SubCriterionSchema).optional(),
});

export const RubricSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  criteria: z.array(RubricCriterionSchema).min(1),
});

export type SubCriterion = z.infer<typeof SubCriterionSchema>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export type Rubric = z.infer<typeof RubricSchema>;
