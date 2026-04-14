/**
 * Phase 7.5 — secret resolver.
 *
 * Resolves an `auth_secret_ref` (e.g. "PORTAL_TOKEN_COHORT_<id>") into the
 * actual secret value. The order is:
 *   1. process.env[ref]
 *   2. local secret file at $KILN_SECRET_DIR/<ref>  (DEFERRED: real vault)
 *
 * Returns a discriminated union so callers MUST handle the missing case
 * explicitly. The successful `value` is NEVER passed to a logger anywhere
 * in the dispatch worker; callers thread it directly into the auth header
 * builder.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type ResolveSecretResult = { ok: true; value: string } | { ok: false; error: string };

export async function resolveSecret(ref: string | null | undefined): Promise<ResolveSecretResult> {
  if (!ref) {
    return { ok: false, error: "missing_secret_ref" };
  }

  const fromEnv = process.env[ref];
  if (fromEnv && fromEnv.length > 0) {
    return { ok: true, value: fromEnv };
  }

  const secretDir = process.env.KILN_SECRET_DIR;
  if (secretDir) {
    try {
      const fp = path.join(secretDir, ref);
      const raw = await readFile(fp, "utf8");
      const value = raw.trim();
      if (value.length > 0) return { ok: true, value };
    } catch {
      // fall through to error
    }
  }

  return { ok: false, error: `secret_not_found:${ref}` };
}
