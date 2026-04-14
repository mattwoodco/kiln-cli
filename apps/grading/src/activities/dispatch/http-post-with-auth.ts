/**
 * Phase 7.5 — http-post-with-auth activity.
 *
 * Posts a JSON payload to a target URL with one of three auth modes:
 *   - bearer: `Authorization: Bearer <secret>`
 *   - hmac:   `X-Signature: sha256=<hex>` over the request body
 *   - none:   no auth header
 *
 * 30s hard timeout via AbortController. Catches network errors and returns
 * `{ httpStatus: 0, error: "network: <msg>" }` so the workflow retry loop
 * can decide whether to retry.
 *
 * The resolved secret is NEVER logged or returned in any field. The error
 * field passes through `redactString` defensively in case fetch surfaces
 * the URL with embedded creds (which it shouldn't, but belt + suspenders).
 */

import { createHmac } from "node:crypto";
import { redactString } from "./redact-payload.js";

export type DispatchAuthMode = "bearer" | "hmac" | "none";

export interface HttpPostInput {
  url: string;
  authMode: DispatchAuthMode;
  /**
   * Resolved secret — must NEVER be logged. Required when authMode is
   * `bearer` or `hmac`. Ignored for `none`.
   */
  secret: string | null;
  payload: unknown;
  /** Optional override for tests. */
  fetchImpl?: typeof fetch;
}

export interface HttpPostResult {
  httpStatus: number;
  latencyMs: number;
  responseBody: string;
  error?: string;
}

const TIMEOUT_MS = 30_000;

export async function httpPostWithAuth(input: HttpPostInput): Promise<HttpPostResult> {
  const body = JSON.stringify(input.payload ?? {});
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "kiln-dispatch/0.1",
  };

  if (input.authMode === "bearer") {
    if (!input.secret) {
      return { httpStatus: 0, latencyMs: 0, responseBody: "", error: "missing_secret" };
    }
    headers.authorization = `Bearer ${input.secret}`;
  } else if (input.authMode === "hmac") {
    if (!input.secret) {
      return { httpStatus: 0, latencyMs: 0, responseBody: "", error: "missing_secret" };
    }
    const sig = createHmac("sha256", input.secret).update(body).digest("hex");
    headers["x-signature"] = `sha256=${sig}`;
  }

  const fetchFn = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetchFn(input.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    let respBody = "";
    try {
      respBody = await res.text();
    } catch {
      respBody = "";
    }
    // Defensive: redact the response body before persisting anywhere.
    return {
      httpStatus: res.status,
      latencyMs,
      responseBody: redactString(respBody.slice(0, 8192)),
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      httpStatus: 0,
      latencyMs,
      responseBody: "",
      error: `network: ${redactString(msg)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
