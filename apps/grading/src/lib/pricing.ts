/**
 * Anthropic pricing lookup.
 *
 * Source: https://www.anthropic.com/pricing
 * Prices are USD per 1M tokens.
 *
 * Update this constant and the table together whenever pricing moves.
 */
export const PRICING_LAST_UPDATED = "2026-04-14";

export type TokenType = "input" | "output" | "cache_read" | "cache_write";

export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  // Anthropic Claude Opus 4.6
  "claude-opus-4-6": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  // Anthropic Claude Sonnet 4.6
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  // Anthropic Claude Haiku 4.6
  "claude-haiku-4-6": { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
  // Legacy aliases kept for compatibility with staged rollouts
  "claude-3-5-sonnet-latest": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-3-opus-latest": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
};

export function getModelPricing(model: string): ModelPricing {
  // Match exact first, then prefix (handles date-suffixed ids like
  // `claude-sonnet-4-6-20260101`).
  if (PRICING_TABLE[model]) return PRICING_TABLE[model];
  for (const [key, val] of Object.entries(PRICING_TABLE)) {
    if (model.startsWith(key)) return val;
  }
  // Unknown model — return zero pricing so costs don't explode mid-run.
  // The trackedLLMCall path logs a warning when this happens.
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const p = getModelPricing(model);
  const perM = (count: number, price: number): number => (count / 1_000_000) * price;
  return (
    perM(inputTokens, p.input) +
    perM(outputTokens, p.output) +
    perM(cacheReadTokens, p.cache_read) +
    perM(cacheWriteTokens, p.cache_write)
  );
}
