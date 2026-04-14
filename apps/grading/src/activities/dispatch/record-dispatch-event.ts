/**
 * Phase 7.5 — record-dispatch-event activity.
 *
 * Single-row insert into `dispatch_events`. The caller MUST have already
 * redacted any error string and stripped the Authorization header from
 * the response body — this activity does not see the resolved secret.
 */

import type { DispatchEventStatus } from "@kiln/shared";
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../../db/schema.js";
import { redactString } from "./redact-payload.js";

type DispatchDb = NodePgDatabase<typeof schema>;

let cachedPool: pg.Pool | null = null;
let cachedDb: DispatchDb | null = null;

function getDb(): DispatchDb {
  if (cachedDb) return cachedDb;
  const connectionString = process.env.DATABASE_URL ?? "postgres://kiln:kiln@localhost:5432/kiln";
  cachedPool = new pg.Pool({ connectionString, max: 4 });
  cachedDb = drizzle(cachedPool, { schema });
  return cachedDb;
}

export interface RecordDispatchEventInput {
  targetId: string;
  submissionId: string;
  cohortId: string;
  attempt: number;
  status: DispatchEventStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
  payloadBytes: number;
  responseRef: string | null;
}

export interface RecordDispatchEventResult {
  eventId: string;
}

export async function recordDispatchEvent(
  input: RecordDispatchEventInput,
): Promise<RecordDispatchEventResult> {
  const db = getDb();
  const [row] = await db
    .insert(schema.dispatchEvents)
    .values({
      targetId: input.targetId,
      submissionId: input.submissionId,
      cohortId: input.cohortId,
      attempt: input.attempt,
      status: input.status,
      httpStatus: input.httpStatus,
      latencyMs: input.latencyMs,
      // Defence in depth: redact one more time at the persistence boundary.
      error: input.error ? redactString(input.error).slice(0, 4096) : null,
      payloadBytes: input.payloadBytes,
      responseRef: input.responseRef,
    })
    .returning();
  if (!row) throw new Error("dispatch_events_insert_failed");
  return { eventId: row.id };
}
