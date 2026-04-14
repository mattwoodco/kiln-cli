/**
 * Proxy upstream → local port mapping.
 * The Kiln harness launches one process per upstream; ports are stable so the
 * CLI, activities, and tests all agree.
 */
export const PROXY_PORTS = {
  anthropic: 9100,
  openai: 9101,
  google: 9102,
} as const;

export type ProxyUpstream = keyof typeof PROXY_PORTS;

/**
 * Ring buffer defaults for the Go proxy's request/response capture.
 * Tuned so a typical 3-hour coding session stays in memory without OOM.
 */
export const BUFFER_DEFAULTS = {
  ringBytes: 32 * 1024 * 1024, // 32 MiB in-memory ring per upstream
  flushIntervalMs: 100, // flush batched entries every 100ms
  flushThresholdBytes: 64 * 1024, // ...or when 64 KiB of entries accumulate
} as const;

/**
 * Hard performance budgets. Breaching these in local benchmarks fails CI.
 */
export const PERFORMANCE_BUDGETS = {
  gradingMs: 180_000, // full grading pipeline per submission
  checkpointMs: 90_000, // mid-week checkpoint report
  proxyOverheadMs: 5, // added latency per proxied request (p95)
} as const;
