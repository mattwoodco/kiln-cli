import { describe, expect, it } from "vitest";
import {
  PRICING_LAST_UPDATED,
  estimateCost,
  getModelPricing,
} from "../src/lib/pricing.js";

describe("pricing", () => {
  it("exposes a PRICING_LAST_UPDATED constant", () => {
    expect(PRICING_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns known pricing for sonnet", () => {
    const p = getModelPricing("claude-sonnet-4-6");
    expect(p.input).toBe(3);
    expect(p.output).toBe(15);
  });

  it("matches by prefix when the model id has a date suffix", () => {
    const p = getModelPricing("claude-sonnet-4-6-20260101");
    expect(p.input).toBe(3);
  });

  it("returns zero pricing for an unknown model", () => {
    const p = getModelPricing("unknown-model-xyz");
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
  });

  it("estimates cost for known input/output counts", () => {
    // Sonnet: $3/1M in, $15/1M out
    //  1M in + 0.5M out = $3 + $7.5 = $10.5
    const cost = estimateCost("claude-sonnet-4-6", 1_000_000, 500_000);
    expect(cost).toBeCloseTo(10.5, 5);
  });

  it("factors in cache read/write discounts", () => {
    // Sonnet: cache_read $0.30/1M, cache_write $3.75/1M
    const cost = estimateCost("claude-sonnet-4-6", 0, 0, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.3 + 3.75, 5);
  });
});
