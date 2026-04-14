import yaml from "js-yaml";
import { z } from "zod";

/**
 * Structural validator for a chaos profile YAML.
 *
 * The `PATCH /api/admin/cohorts/:id/weeks/:n/hidden-chaos` endpoint needs to
 * reject hidden profiles whose fault categories or steady-state criteria
 * drift from the matching visible profile. The rubric design is
 * "same rules, unseen permutations" — the hidden set may tweak parameters
 * (latency, drop rate, targets) but must stay within the same fault types
 * and must keep steady-state semantics consistent.
 */

const ChaosYamlExperimentSchema = z.object({
  id: z.string(),
  fault: z.object({
    kind: z.enum([
      "latency",
      "drop",
      "error_status",
      "partial_response",
      "rate_limit",
      "token_limit",
      "mutation",
      "disconnect",
    ]),
    target: z.string(),
    parameters: z.record(z.string(), z.unknown()).default({}),
  }),
  steady_state: z.object({
    metric: z.string(),
    operator: z.enum(["lt", "lte", "gt", "gte", "eq"]),
    threshold: z.number(),
  }),
});

const ChaosYamlSchema = z.object({
  version: z.string(),
  profile: z.enum(["visible", "hidden"]),
  experiments: z.array(ChaosYamlExperimentSchema).min(1),
});

export type ChaosYamlDoc = z.infer<typeof ChaosYamlSchema>;

export function parseChaosYaml(text: string): ChaosYamlDoc {
  const raw = yaml.load(text);
  return ChaosYamlSchema.parse(raw);
}

/**
 * Fault categories = the sorted set of unique `fault.kind` values.
 * Steady-state criteria = the sorted set of unique `metric:operator` pairs.
 *
 * Hidden profile must be a non-strict superset: it must not introduce any
 * fault kind or steady-state criterion that isn't also in the visible set.
 */
export interface ChaosProfileShape {
  faultKinds: string[];
  steadyStateCriteria: string[];
}

export function shapeOf(doc: ChaosYamlDoc): ChaosProfileShape {
  const faults = new Set<string>();
  const criteria = new Set<string>();
  for (const exp of doc.experiments) {
    faults.add(exp.fault.kind);
    criteria.add(`${exp.steady_state.metric}:${exp.steady_state.operator}`);
  }
  return {
    faultKinds: [...faults].sort(),
    steadyStateCriteria: [...criteria].sort(),
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateHiddenAgainstVisible(
  visibleYaml: string,
  hiddenYaml: string,
): ValidationResult {
  const errors: string[] = [];
  let visible: ChaosYamlDoc | undefined;
  let hidden: ChaosYamlDoc | undefined;
  try {
    visible = parseChaosYaml(visibleYaml);
  } catch (err) {
    errors.push(`visible_yaml_invalid: ${(err as Error).message}`);
  }
  try {
    hidden = parseChaosYaml(hiddenYaml);
  } catch (err) {
    errors.push(`hidden_yaml_invalid: ${(err as Error).message}`);
  }
  if (!visible || !hidden) return { ok: false, errors };

  const v = shapeOf(visible);
  const h = shapeOf(hidden);

  const newKinds = h.faultKinds.filter((k) => !v.faultKinds.includes(k));
  if (newKinds.length > 0) {
    errors.push(`hidden_profile_introduces_new_fault_kinds: ${newKinds.join(",")}`);
  }
  const newCriteria = h.steadyStateCriteria.filter((c) => !v.steadyStateCriteria.includes(c));
  if (newCriteria.length > 0) {
    errors.push(`hidden_profile_introduces_new_steady_state_criteria: ${newCriteria.join(",")}`);
  }
  return { ok: errors.length === 0, errors };
}
