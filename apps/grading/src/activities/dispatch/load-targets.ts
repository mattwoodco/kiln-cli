/**
 * Phase 7.5 — load-targets activity.
 *
 * Drizzle query strictly scoped by `cohort_id`. Returns enabled targets
 * whose `triggerOn` array includes the requested trigger, with week-scoped
 * targets winning over cohort-wide targets that share a name.
 *
 * Resolution rule:
 *   ORDER BY (week_id IS NULL) ASC, created_at ASC
 *   then keep first row per `name`.
 */

import type { DispatchTarget, DispatchTrigger } from "@kiln/shared";
import { and, eq } from "drizzle-orm";
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../../db/schema.js";

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

export async function closeDispatchDb(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    cachedDb = null;
  }
}

export interface LoadTargetsInput {
  cohortId: string;
  weekId: string;
  trigger: DispatchTrigger;
}

function rowToTarget(row: typeof schema.dispatchTargets.$inferSelect): DispatchTarget {
  return {
    id: row.id,
    cohortId: row.cohortId,
    weekId: row.weekId,
    name: row.name,
    url: row.url,
    authMode: row.authMode as DispatchTarget["authMode"],
    authSecretRef: row.authSecretRef,
    artifactSelectors: row.artifactSelectors as DispatchTarget["artifactSelectors"],
    transformTemplate: row.transformTemplate,
    retryPolicy: row.retryPolicy,
    triggerOn: row.triggerOn as DispatchTarget["triggerOn"],
    enabled: row.enabled,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export async function loadTargets(input: LoadTargetsInput): Promise<DispatchTarget[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.dispatchTargets)
    .where(
      and(
        eq(schema.dispatchTargets.cohortId, input.cohortId),
        eq(schema.dispatchTargets.enabled, true),
      ),
    );

  const matching = rows
    .filter((r) => {
      const triggers = (r.triggerOn ?? []) as string[];
      return triggers.includes(input.trigger);
    })
    .filter((r) => r.weekId === null || r.weekId === input.weekId);

  // Sort: week-scoped first, then by createdAt
  matching.sort((a, b) => {
    const aWeek = a.weekId ? 0 : 1;
    const bWeek = b.weekId ? 0 : 1;
    if (aWeek !== bWeek) return aWeek - bWeek;
    const aTime = a.createdAt ? a.createdAt.getTime() : 0;
    const bTime = b.createdAt ? b.createdAt.getTime() : 0;
    return aTime - bTime;
  });

  // Dedupe by name, week-scoped wins.
  const seen = new Set<string>();
  const out: DispatchTarget[] = [];
  for (const r of matching) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(rowToTarget(r));
  }
  return out;
}
