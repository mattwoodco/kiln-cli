import { describe, expect, it } from "vitest";
import {
  PORTAL_DEFAULT_SELECTORS,
  PORTAL_DEFAULT_TRANSFORM,
  PORTAL_TARGET_NAME,
  extractResponseRef,
  portalSecretRef,
} from "../src/dispatch/targets/portal.js";
import { applyTransform } from "../src/activities/dispatch/build-payload.js";

describe("portal target shaper", () => {
  it("declares default selectors as one_sheet + ai_usage", () => {
    expect(PORTAL_DEFAULT_SELECTORS).toEqual(["one_sheet", "ai_usage"]);
  });

  it("templates secret ref per cohort", () => {
    expect(portalSecretRef("c-123")).toBe("PORTAL_TOKEN_COHORT_c-123");
  });

  it("uses the canonical portal target name", () => {
    expect(PORTAL_TARGET_NAME).toBe("kiln-portal");
  });

  it("default transform produces the Portal payload shape", () => {
    const input = {
      submission_id: "sub-1",
      student_id: "stu-1",
      rubric_version: "rv-7",
      one_sheet: { overall_score: 85 },
      ai_usage: { total_cost_usd: 0.42 },
    };
    const out = applyTransform(input, PORTAL_DEFAULT_TRANSFORM) as Record<string, unknown>;
    expect(out.submission_id).toBe("sub-1");
    expect(out.student_id).toBe("stu-1");
    expect(out.rubric_version).toBe("rv-7");
    expect(out.one_sheet).toEqual({ overall_score: 85 });
    expect(out.ai_usage).toEqual({ total_cost_usd: 0.42 });
  });

  it("extractResponseRef plucks job_id from JSON string", () => {
    expect(extractResponseRef('{"job_id":"job-42"}')).toBe("job-42");
  });

  it("extractResponseRef plucks interview_id when job_id missing", () => {
    expect(extractResponseRef('{"interview_id":"int-99"}')).toBe("int-99");
  });

  it("extractResponseRef returns null when neither key present", () => {
    expect(extractResponseRef('{"status":"ok"}')).toBeNull();
  });

  it("extractResponseRef returns null on invalid JSON", () => {
    expect(extractResponseRef("not-json")).toBeNull();
  });
});
