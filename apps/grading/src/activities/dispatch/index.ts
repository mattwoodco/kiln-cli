export { loadTargets, closeDispatchDb } from "./load-targets.js";
export type { LoadTargetsInput } from "./load-targets.js";
export { buildPayload, dottedGet, applyTransform } from "./build-payload.js";
export type {
  BuildPayloadInput,
  BuildPayloadResult,
} from "./build-payload.js";
export { redactPayload, redactString } from "./redact-payload.js";
export { resolveSecret } from "./resolve-secret.js";
export type { ResolveSecretResult } from "./resolve-secret.js";

import { resolveSecret as _resolveSecret } from "./resolve-secret.js";
import type { ResolveSecretResult as _ResolveSecretResult } from "./resolve-secret.js";

/**
 * Workflow-callable wrapper. We don't expose `resolveSecret` directly
 * because the activity registration name (`resolveSecretActivity`) is
 * matched verbatim by the dispatch-single-target workflow.
 */
export async function resolveSecretActivity(ref: string | null): Promise<_ResolveSecretResult> {
  return _resolveSecret(ref);
}
export { httpPostWithAuth } from "./http-post-with-auth.js";
export type { HttpPostInput, HttpPostResult } from "./http-post-with-auth.js";
export { recordDispatchEvent } from "./record-dispatch-event.js";
export type {
  RecordDispatchEventInput,
  RecordDispatchEventResult,
} from "./record-dispatch-event.js";
