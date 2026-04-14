/**
 * Number formatting helpers for `kiln admin usage`.
 *
 * Plan ref: Phase 7 §3 (lines 1104-1107).
 *
 * Single source of truth — every CLI usage table goes through these so we
 * don't end up with `0.5` in one place and `$0.50` in another.
 */

/**
 * USD with 4 decimal places, comma thousands separator, leading `$`.
 *
 *     formatUsd(1234.56789)  // "$1,234.5679"
 *     formatUsd(0)           // "$0.0000"
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "$0.0000";
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const fixed = abs.toFixed(4);
  const [whole, frac] = fixed.split(".");
  const withCommas = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${withCommas}.${frac ?? "0000"}`;
}

/**
 * Token counts with K / M / B suffixes.
 *
 *     formatTokens(123)          // "123"
 *     formatTokens(1234)         // "1.2K"
 *     formatTokens(1_234_567)    // "1.2M"
 *     formatTokens(1_234_567_890) // "1.2B"
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${(count / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Duration in `Xms`, `Xs`, or `XmYs` form. Includes a `p95 ` prefix variant.
 *
 *     formatDuration(42)      // "42ms"
 *     formatDuration(4200)    // "4.2s"
 *     formatDuration(75_000)  // "1m15s"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * Format a fraction in [0,1] as a percentage with 1 decimal place.
 *
 *     formatPercent(0.4123) // "41.2%"
 */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0.0%";
  return `${(fraction * 100).toFixed(1)}%`;
}
