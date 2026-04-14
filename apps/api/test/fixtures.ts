import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema.js";

/**
 * Test fixtures connected to the docker compose postgres.
 *
 * Tests that need a DB use `withTestDb` which truncates cohort-scoped rows
 * before each run and inserts deterministic fixtures.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://kiln:kiln@192.168.147.2:5432/kiln";

export interface TestHarness {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
  cohortA: { id: string };
  cohortB: { id: string };
  weekA: { id: string; cohortId: string };
  weekB: { id: string; cohortId: string };
  studentA: { id: string };
  studentB: { id: string };
  admin: { id: string };
  close: () => Promise<void>;
}

const HIDDEN_VISIBLE_YAML = `version: "1"
profile: visible
experiments:
  - id: e1
    fault:
      kind: latency
      target: api
      parameters: { ms: 100 }
    steady_state:
      metric: p99
      operator: lt
      threshold: 500
`;

const HIDDEN_YAML = `version: "1"
profile: hidden
experiments:
  - id: h1
    fault:
      kind: latency
      target: api
      parameters: { ms: 900 }
    steady_state:
      metric: p99
      operator: lt
      threshold: 500
`;

export const TEST_VISIBLE_CHAOS_YAML = HIDDEN_VISIBLE_YAML;
export const TEST_HIDDEN_CHAOS_YAML = HIDDEN_YAML;
// A canary byte present only in the hidden YAML, used to grep responses.
export const HIDDEN_CANARY = "h1";

export async function setupHarness(): Promise<TestHarness> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const db = drizzle(pool, { schema });

  // Clear child tables first (FK order).
  await db.execute(sql`TRUNCATE TABLE
    dispatch_events,
    dispatch_targets,
    pipeline_usage_events,
    usage_daily_rollups,
    usage_alerts,
    grader_overrides,
    grading_results,
    checkpoints,
    submissions,
    weeks,
    cohort_members,
    users,
    cohorts
    RESTART IDENTITY CASCADE`);

  const [cohortA] = await db
    .insert(schema.cohorts)
    .values({ name: "cohort-A", startDate: "2026-01-01" })
    .returning();
  const [cohortB] = await db
    .insert(schema.cohorts)
    .values({ name: "cohort-B", startDate: "2026-01-01" })
    .returning();
  if (!cohortA || !cohortB) throw new Error("cohort insert failed");

  const [weekA] = await db
    .insert(schema.weeks)
    .values({
      cohortId: cohortA.id,
      weekNumber: 1,
      title: "Circuit Breakers A",
      rubricYaml: "name: rubric-A\nversion: 1\ncriteria: []\n",
      visibleChaosYaml: HIDDEN_VISIBLE_YAML,
      hiddenChaosYaml: HIDDEN_YAML,
    })
    .returning();
  const [weekB] = await db
    .insert(schema.weeks)
    .values({
      cohortId: cohortB.id,
      weekNumber: 1,
      title: "Circuit Breakers B",
      rubricYaml: "name: rubric-B\nversion: 1\ncriteria: []\n",
      visibleChaosYaml: HIDDEN_VISIBLE_YAML,
    })
    .returning();
  if (!weekA || !weekB) throw new Error("week insert failed");

  const [studentA] = await db
    .insert(schema.users)
    .values({ email: "stu-a@kiln.local", name: "Stu A", role: "student" })
    .returning();
  const [studentB] = await db
    .insert(schema.users)
    .values({ email: "stu-b@kiln.local", name: "Stu B", role: "student" })
    .returning();
  const [admin] = await db
    .insert(schema.users)
    .values({ email: "admin@kiln.local", name: "Admin", role: "admin" })
    .returning();
  if (!studentA || !studentB || !admin) throw new Error("user insert failed");

  await db.insert(schema.cohortMembers).values([
    { userId: studentA.id, cohortId: cohortA.id, role: "student" },
    { userId: studentB.id, cohortId: cohortB.id, role: "student" },
  ]);

  return {
    db,
    pool,
    cohortA: { id: cohortA.id },
    cohortB: { id: cohortB.id },
    weekA: { id: weekA.id, cohortId: cohortA.id },
    weekB: { id: weekB.id, cohortId: cohortB.id },
    studentA: { id: studentA.id },
    studentB: { id: studentB.id },
    admin: { id: admin.id },
    close: async () => {
      await pool.end();
    },
  };
}
