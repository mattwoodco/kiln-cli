/**
 * Phase 7.5 — payload redaction sweep.
 *
 * Walks an arbitrary JSON value and replaces any string fields that match
 * known secret patterns. Used by the dispatch worker BEFORE the payload is
 * sent over the wire AND before any error string is persisted.
 *
 * Patterns covered:
 *   - sk-ant-*  (Anthropic API keys)
 *   - sk-*      (OpenAI / generic API keys)
 *   - glpat-*   (GitLab Personal Access Tokens)
 *   - ghp_*     (GitHub Personal Access Tokens)
 *   - "Bearer <token>" anywhere in a string
 */

const PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

const REDACTED = "[REDACTED]";

export function redactString(input: string): string {
  let out = input;
  for (const pat of PATTERNS) {
    out = out.replace(pat, REDACTED);
  }
  return out;
}

export function redactPayload<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(walk);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}
