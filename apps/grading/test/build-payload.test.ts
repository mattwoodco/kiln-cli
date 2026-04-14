import { describe, expect, it } from "vitest";
import { applyTransform, dottedGet } from "../src/activities/dispatch/build-payload.js";

describe("dottedGet", () => {
  it("walks single-segment paths", () => {
    expect(dottedGet({ a: 1 }, "a")).toBe(1);
  });

  it("walks deep paths", () => {
    expect(dottedGet({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns undefined for missing intermediate", () => {
    expect(dottedGet({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  it("never uses eval (does not interpret arbitrary strings)", () => {
    // Defensive: ensure a path like `__proto__.polluted` does not return
    // something useful from prototype.
    expect(dottedGet({}, "__proto__.polluted")).toBeUndefined();
  });

  it("returns the value itself for empty path", () => {
    expect(dottedGet({ a: 1 }, "")).toEqual({ a: 1 });
  });
});

describe("applyTransform", () => {
  it("walks dotted paths in the template", () => {
    const input = {
      one_sheet: { overall_score: 85, overall_grade: "B+" },
      ai_usage: { total_cost_usd: 0.5 },
    };
    const template = JSON.stringify({
      score: "one_sheet.overall_score",
      grade: "one_sheet.overall_grade",
      cost: "ai_usage.total_cost_usd",
    });
    expect(applyTransform(input, template)).toEqual({
      score: 85,
      grade: "B+",
      cost: 0.5,
    });
  });

  it("returns the input unchanged when template is null", () => {
    const input = { foo: 1 };
    expect(applyTransform(input, null)).toBe(input);
  });

  it("returns the input unchanged when template is invalid JSON", () => {
    const input = { foo: 1 };
    expect(applyTransform(input, "not valid")).toBe(input);
  });

  it("handles missing fields by emitting undefined", () => {
    const out = applyTransform(
      { a: 1 },
      JSON.stringify({ x: "missing.field" }),
    ) as Record<string, unknown>;
    expect(out.x).toBeUndefined();
  });
});
