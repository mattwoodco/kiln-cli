/**
 * Phase 8 — PRICING_LAST_UPDATED staleness warning.
 *
 * The admin usage routes emit a `pricingWarning` when the pricing table
 * is more than 90 days old. This test pins a fixed "now" against the
 * real `PRICING_LAST_UPDATED` constant and asserts the warning fires
 * only after the 90-day threshold.
 */

import { describe, expect, it } from "vitest";
import {
  PRICING_LAST_UPDATED,
  PRICING_STALE_DAYS,
  pricingIsStale,
  pricingWarning,
} from "../src/routes/admin/usage.js";

describe("pricing staleness", () => {
  const last = new Date(`${PRICING_LAST_UPDATED}T00:00:00Z`);

  it("is NOT stale one day after the last update", () => {
    const now = new Date(last.getTime() + 1 * 24 * 3600 * 1000);
    expect(pricingIsStale(now)).toBe(false);
    expect(pricingWarning(now)).toBeUndefined();
  });

  it("is NOT stale exactly at the boundary", () => {
    const now = new Date(last.getTime() + PRICING_STALE_DAYS * 24 * 3600 * 1000);
    expect(pricingIsStale(now)).toBe(false);
  });

  it("IS stale one day past the threshold", () => {
    const now = new Date(last.getTime() + (PRICING_STALE_DAYS + 1) * 24 * 3600 * 1000);
    expect(pricingIsStale(now)).toBe(true);
    const warning = pricingWarning(now);
    expect(warning).toBeDefined();
    expect(warning).toMatch(/pricing table last updated/);
    expect(warning).toContain(PRICING_LAST_UPDATED);
  });

  it("IS stale far in the future", () => {
    const now = new Date(last.getTime() + 365 * 24 * 3600 * 1000);
    expect(pricingIsStale(now)).toBe(true);
  });
});
