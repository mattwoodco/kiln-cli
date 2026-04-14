import fastifyJwt from "@fastify/jwt";
import { RubricSchema } from "@kiln/shared";
import { and, desc, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import yaml from "js-yaml";
import { z } from "zod";
import { getDb, schema } from "./db/index.js";
import {
  type CohortScope,
  type KilnJwtPayload,
  assertCohortMatch,
  requireCohortScope,
  requireRole,
} from "./lib/auth.js";
import { validateHiddenAgainstVisible } from "./lib/chaos-yaml.js";
import {
  CHECKPOINT_SUBMISSION_WORKFLOW,
  GRADE_SUBMISSION_WORKFLOW,
  GRADING_TASK_QUEUE,
  describeWorkflow,
  getTemporalClient,
} from "./lib/temporal.js";
import { registerAdminDispatchRoutes } from "./routes/admin/dispatch.js";
import { registerAdminUsageRoutes } from "./routes/admin/usage.js";

// ---------------------------------------------------------------------------
// Request body schemas
// ---------------------------------------------------------------------------

const LoginSchema = z.object({
  email: z.string().email(),
  role: z.enum(["student", "grader", "admin"]).optional(),
});

const SubmissionSchema = z.object({
  repoUrl: z.string().url(),
  commitSha: z.string().min(7).max(40),
  weekNumber: z.number().int().nonnegative(),
  stage: z.enum(["early", "final"]).default("final"),
});

const GitLabWebhookSchema = z.object({
  object_kind: z.literal("push").optional(),
  after: z.string().optional(),
  ref: z.string().optional(),
  user_username: z.string().optional(),
  project: z
    .object({
      web_url: z.string().optional(),
      path_with_namespace: z.string().optional(),
    })
    .optional(),
});

const CreateCohortSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  startDate: z.string(),
  endDate: z.string().optional(),
  maxStudents: z.number().int().positive().optional(),
});

const CreateWeekSchema = z.object({
  weekNumber: z.number().int().nonnegative(),
  title: z.string(),
  projectSlug: z.string().optional(),
  rubricYaml: z.string().min(1),
  rubricVersion: z.string().optional(),
  templateRepoUrl: z.string().optional(),
  visibleChaosYaml: z.string().optional(),
});

const HiddenChaosPatchSchema = z.object({
  hiddenChaosYaml: z.string().min(1),
});

const AddMemberSchema = z.object({
  email: z.string().email(),
  name: z.string(),
  role: z.enum(["student", "grader"]),
});

const CheckpointConfigPatchSchema = z.object({
  checkpoint_retention_days: z.number().int().positive().optional(),
  checkpoints_enabled: z.boolean().optional(),
});

const CheckpointRequestSchema = z.object({
  repoUrl: z.string().url(),
  commitSha: z.string().min(7).max(40),
  weekNumber: z.number().int().nonnegative(),
  persist: z.boolean().optional().default(false),
});

const CheckpointHistoryQuerySchema = z.object({
  weekNumber: z.coerce.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? "dev-kiln-secret-change-me",
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  app.get("/healthz", async () => ({ status: "ok" }));

  // -------------------------------------------------------------------------
  // Auth — DEV-ONLY login. Issues a JWT for any known user email.
  // DEFERRED: real password/OAuth. Tracked in PROGRESS.md.
  // -------------------------------------------------------------------------
  app.post("/api/auth/login", async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const db = getDb();
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, parsed.data.email))
      .limit(1);
    if (!user) {
      return reply.code(404).send({ error: "user_not_found" });
    }
    const [membership] = await db
      .select()
      .from(schema.cohortMembers)
      .where(eq(schema.cohortMembers.userId, user.id))
      .limit(1);
    if (!membership && user.role !== "admin") {
      return reply.code(403).send({ error: "no_cohort_membership" });
    }
    const payload: KilnJwtPayload = {
      userId: user.id,
      cohortId: membership?.cohortId ?? "",
      role: (parsed.data.role ?? user.role) as KilnJwtPayload["role"],
    };
    const token = app.jwt.sign(payload);
    return { token, payload };
  });

  // -------------------------------------------------------------------------
  // GET /api/me — current user, cohort, active week
  // -------------------------------------------------------------------------
  app.get("/api/me", async (request, reply) => {
    const scope = await requireCohortScope(request, reply);
    if (!scope) return;
    const db = getDb();
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, scope.userId))
      .limit(1);
    if (!user) return reply.code(404).send({ error: "user_not_found" });

    let cohort: typeof schema.cohorts.$inferSelect | undefined;
    if (scope.cohortId) {
      [cohort] = await db
        .select()
        .from(schema.cohorts)
        .where(eq(schema.cohorts.id, scope.cohortId))
        .limit(1);
    }

    // Current week = lowest is_active week for this cohort.
    let currentWeek: { weekNumber: number; title: string } | null = null;
    if (cohort) {
      const allWeeks = await db
        .select({
          weekNumber: schema.weeks.weekNumber,
          title: schema.weeks.title,
          isActive: schema.weeks.isActive,
        })
        .from(schema.weeks)
        .where(eq(schema.weeks.cohortId, cohort.id));
      const active = allWeeks.filter((w) => w.isActive).sort((a, b) => a.weekNumber - b.weekNumber);
      if (active.length > 0 && active[0]) {
        currentWeek = { weekNumber: active[0].weekNumber, title: active[0].title };
      }
    }

    return {
      user: { id: user.id, email: user.email, name: user.name, role: scope.role },
      cohort: cohort ? { id: cohort.id, name: cohort.name, description: cohort.description } : null,
      currentWeek,
    };
    // NOTE: `hidden_chaos_yaml` is never returned here. See integration test
    // `hidden-chaos-isolation.test.ts`.
  });

  // -------------------------------------------------------------------------
  // GET /api/cohorts/:id/weeks/:n — week config for students + graders.
  // CRITICAL: must NOT return hidden_chaos_yaml.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string; n: string } }>(
    "/api/cohorts/:id/weeks/:n",
    async (request, reply) => {
      const scope = await requireCohortScope(request, reply);
      if (!scope) return;
      if (!(await assertCohortMatch(reply, scope, request.params.id))) return;
      const weekNumber = Number(request.params.n);
      if (!Number.isFinite(weekNumber)) {
        return reply.code(400).send({ error: "invalid_week_number" });
      }
      const db = getDb();
      const [week] = await db
        .select({
          id: schema.weeks.id,
          weekNumber: schema.weeks.weekNumber,
          title: schema.weeks.title,
          projectSlug: schema.weeks.projectSlug,
          rubricYaml: schema.weeks.rubricYaml,
          rubricVersion: schema.weeks.rubricVersion,
          templateRepoUrl: schema.weeks.templateRepoUrl,
          visibleChaosYaml: schema.weeks.visibleChaosYaml,
          isActive: schema.weeks.isActive,
        })
        .from(schema.weeks)
        .where(
          and(
            eq(schema.weeks.cohortId, request.params.id),
            eq(schema.weeks.weekNumber, weekNumber),
          ),
        )
        .limit(1);
      if (!week) return reply.code(404).send({ error: "week_not_found" });
      // Explicit SELECT above guarantees hidden_chaos_yaml is excluded.
      return week;
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/submissions
  // -------------------------------------------------------------------------
  app.post("/api/submissions", async (request, reply) => {
    const scope = await requireCohortScope(request, reply);
    if (!scope) return;
    const parsed = SubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const db = getDb();
    const [week] = await db
      .select()
      .from(schema.weeks)
      .where(
        and(
          eq(schema.weeks.cohortId, scope.cohortId),
          eq(schema.weeks.weekNumber, parsed.data.weekNumber),
        ),
      )
      .limit(1);
    if (!week) return reply.code(404).send({ error: "week_not_found" });

    // Early-deadline gating: reject stage="early" after the window has closed.
    // DEFERRED: real early-deadline policy. For MVP we only check if the
    // column is set and compare timestamps.
    if (parsed.data.stage === "early" && week.earlyDeadline) {
      if (new Date() > week.earlyDeadline) {
        return reply.code(400).send({ error: "early_deadline_passed" });
      }
    }

    const [inserted] = await db
      .insert(schema.submissions)
      .values({
        userId: scope.userId,
        weekId: week.id,
        repoUrl: parsed.data.repoUrl,
        commitSha: parsed.data.commitSha,
        type: "final",
        stage: parsed.data.stage,
        status: "queued",
      })
      .returning();
    if (!inserted) {
      return reply.code(500).send({ error: "submission_insert_failed" });
    }

    // Kick off Temporal workflow.
    const workflowId = `grade-${inserted.id}`;
    const client = await getTemporalClient();
    if (!client) {
      // Infra down — still return the submission so the CLI can poll later.
      return reply.code(503).send({ submissionId: inserted.id, error: "temporal_unavailable" });
    }

    await client.workflow.start(GRADE_SUBMISSION_WORKFLOW, {
      taskQueue: GRADING_TASK_QUEUE,
      workflowId,
      args: [
        {
          submissionId: inserted.id,
          repoUrl: parsed.data.repoUrl,
          commitSha: parsed.data.commitSha,
          weekId: week.id,
          cohortId: scope.cohortId,
          userId: scope.userId,
          rubricYaml: week.rubricYaml,
          stage: parsed.data.stage,
          visibleChaosYaml: week.visibleChaosYaml ?? "",
          hiddenChaosYaml: parsed.data.stage === "final" ? (week.hiddenChaosYaml ?? "") : "",
        },
      ],
    });

    await db
      .update(schema.submissions)
      .set({ workflowId, status: "processing" })
      .where(eq(schema.submissions.id, inserted.id));

    return { submissionId: inserted.id, jobId: workflowId, stage: parsed.data.stage };
  });

  // -------------------------------------------------------------------------
  // POST /api/webhooks/gl — GitLab push webhook
  // DEFERRED: full GitLab push payload coverage. We only parse the minimal
  // fields needed for repo→student+week resolution. The resolution uses
  // a simple regex on `path_with_namespace` as a first pass.
  // -------------------------------------------------------------------------
  app.post("/api/webhooks/gl", async (request, reply) => {
    const expected = process.env.GITLAB_WEBHOOK_TOKEN ?? "";
    const received = request.headers["x-gitlab-token"];
    if (!expected || received !== expected) {
      return reply.code(401).send({ error: "invalid_webhook_token" });
    }
    const parsed = GitLabWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload" });
    }
    const pathNs = parsed.data.project?.path_with_namespace ?? "";
    // Expect `<cohort-slug>/week-<n>/<student-username>` or similar.
    const match = pathNs.match(/^([^/]+)\/week-(\d+)\/([^/]+)$/);
    if (!match) {
      return reply.code(202).send({ status: "ignored_unmatched_repo" });
    }
    const [, cohortSlug, weekStr, studentUsername] = match;
    if (!cohortSlug || !weekStr || !studentUsername) {
      return reply.code(202).send({ status: "ignored_unmatched_repo" });
    }
    const weekNumber = Number(weekStr);
    const commitSha = parsed.data.after ?? "";
    const repoUrl = parsed.data.project?.web_url ?? "";
    const db = getDb();

    // Look up cohort by name slug.
    const [cohort] = await db
      .select()
      .from(schema.cohorts)
      .where(eq(schema.cohorts.name, cohortSlug))
      .limit(1);
    if (!cohort) return reply.code(404).send({ error: "cohort_not_found" });

    const [week] = await db
      .select()
      .from(schema.weeks)
      .where(and(eq(schema.weeks.cohortId, cohort.id), eq(schema.weeks.weekNumber, weekNumber)))
      .limit(1);
    if (!week) return reply.code(404).send({ error: "week_not_found" });

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, `${studentUsername}@kiln.local`))
      .limit(1);
    if (!user) return reply.code(404).send({ error: "student_not_found" });

    const [inserted] = await db
      .insert(schema.submissions)
      .values({
        userId: user.id,
        weekId: week.id,
        repoUrl,
        commitSha,
        type: "final",
        stage: "final",
        status: "queued",
      })
      .returning();
    if (!inserted) return reply.code(500).send({ error: "insert_failed" });

    const workflowId = `grade-${inserted.id}`;
    const client = await getTemporalClient();
    if (client) {
      await client.workflow.start(GRADE_SUBMISSION_WORKFLOW, {
        taskQueue: GRADING_TASK_QUEUE,
        workflowId,
        args: [
          {
            submissionId: inserted.id,
            repoUrl,
            commitSha,
            weekId: week.id,
            cohortId: cohort.id,
            userId: user.id,
            rubricYaml: week.rubricYaml,
            stage: "final",
            visibleChaosYaml: week.visibleChaosYaml ?? "",
            hiddenChaosYaml: week.hiddenChaosYaml ?? "",
          },
        ],
      });
    }

    return reply.code(202).send({ submissionId: inserted.id, jobId: workflowId });
  });

  // -------------------------------------------------------------------------
  // GET /api/results/:id
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/results/:id", async (request, reply) => {
    const scope = await requireCohortScope(request, reply);
    if (!scope) return;
    const db = getDb();
    const rows = await db
      .select({
        result: schema.gradingResults,
        submission: schema.submissions,
        week: schema.weeks,
      })
      .from(schema.gradingResults)
      .innerJoin(schema.submissions, eq(schema.submissions.id, schema.gradingResults.submissionId))
      .innerJoin(schema.weeks, eq(schema.weeks.id, schema.submissions.weekId))
      .where(eq(schema.gradingResults.submissionId, request.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "result_not_found" });

    if (!(await assertCohortMatch(reply, scope, row.week.cohortId))) return;
    if (scope.role === "student" && row.submission.userId !== scope.userId) {
      return reply.code(403).send({ error: "cohort_scope_violation" });
    }
    return row.result;
  });

  // -------------------------------------------------------------------------
  // GET /api/status/:jobId — Temporal workflow status
  // -------------------------------------------------------------------------
  app.get<{ Params: { jobId: string } }>("/api/status/:jobId", async (request, reply) => {
    const scope = await requireCohortScope(request, reply);
    if (!scope) return;
    const info = await describeWorkflow(request.params.jobId);
    if (!info) return reply.code(503).send({ error: "temporal_unavailable_or_not_found" });
    return { jobId: request.params.jobId, status: info.status, runId: info.runId };
  });

  // -------------------------------------------------------------------------
  // POST /api/checkpoints — student-initiated formative checkpoint.
  //
  // Flow:
  //   1. Resolve cohort from JWT.
  //   2. Verify cohort.config.checkpoints_enabled !== false.
  //   3. Insert submission row with type="checkpoint" (no stage).
  //   4. Start `checkpointSubmission` workflow on the grading task queue.
  //   5. Return { checkpointId: submissionId, jobId }.
  //
  // Checkpoint submissions NEVER write to grading_results, and NEVER run
  // the hidden chaos profile. Those rules are enforced both here and
  // inside the workflow body.
  // -------------------------------------------------------------------------
  app.post("/api/checkpoints", async (request, reply) => {
    const scope = await requireCohortScope(request, reply);
    if (!scope) return;
    const parsed = CheckpointRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const db = getDb();

    // Resolve cohort + check checkpoints_enabled.
    const [cohort] = await db
      .select()
      .from(schema.cohorts)
      .where(eq(schema.cohorts.id, scope.cohortId))
      .limit(1);
    if (!cohort) return reply.code(404).send({ error: "cohort_not_found" });
    const cfg = (cohort.config ?? {}) as { checkpoints_enabled?: unknown };
    if (cfg.checkpoints_enabled === false) {
      return reply.code(403).send({ error: "checkpoints_disabled_for_cohort" });
    }

    const [week] = await db
      .select()
      .from(schema.weeks)
      .where(
        and(
          eq(schema.weeks.cohortId, scope.cohortId),
          eq(schema.weeks.weekNumber, parsed.data.weekNumber),
        ),
      )
      .limit(1);
    if (!week) return reply.code(404).send({ error: "week_not_found" });

    const [inserted] = await db
      .insert(schema.submissions)
      .values({
        userId: scope.userId,
        weekId: week.id,
        repoUrl: parsed.data.repoUrl,
        commitSha: parsed.data.commitSha,
        type: "checkpoint",
        // stage is NULL on checkpoint submissions — they are not part of the
        // early/final progression.
        stage: null,
        status: "queued",
      })
      .returning();
    if (!inserted) {
      return reply.code(500).send({ error: "submission_insert_failed" });
    }

    const workflowId = `checkpoint-${inserted.id}`;
    const client = await getTemporalClient();
    if (!client) {
      return reply
        .code(503)
        .send({ checkpointId: inserted.id, jobId: workflowId, error: "temporal_unavailable" });
    }

    await client.workflow.start(CHECKPOINT_SUBMISSION_WORKFLOW, {
      taskQueue: GRADING_TASK_QUEUE,
      workflowId,
      args: [
        {
          submissionId: inserted.id,
          repoUrl: parsed.data.repoUrl,
          commitSha: parsed.data.commitSha,
          weekId: week.id,
          weekNumber: parsed.data.weekNumber,
          cohortId: scope.cohortId,
          userId: scope.userId,
          projectKey: week.projectSlug ?? `week-${parsed.data.weekNumber}`,
          rubricYaml: week.rubricYaml,
          visibleChaosYaml: week.visibleChaosYaml ?? "",
          persist: parsed.data.persist,
        },
      ],
    });

    await db
      .update(schema.submissions)
      .set({ workflowId, status: "processing" })
      .where(eq(schema.submissions.id, inserted.id));

    return { checkpointId: inserted.id, jobId: workflowId };
  });

  // -------------------------------------------------------------------------
  // GET /api/checkpoints/history?weekNumber=N — checkpoint report history
  // for the caller's cohort+week, ordered newest-first.
  //
  // NOTE: this route must be declared BEFORE `/api/checkpoints/:id` so
  // Fastify's router doesn't try to parse "history" as an id parameter.
  // -------------------------------------------------------------------------
  app.get("/api/checkpoints/history", async (request, reply) => {
    const scope = await requireCohortScope(request, reply);
    if (!scope) return;
    const parsed = CheckpointHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    }
    const db = getDb();
    const [week] = await db
      .select()
      .from(schema.weeks)
      .where(
        and(
          eq(schema.weeks.cohortId, scope.cohortId),
          eq(schema.weeks.weekNumber, parsed.data.weekNumber),
        ),
      )
      .limit(1);
    if (!week) return reply.code(404).send({ error: "week_not_found" });

    const rows = await db
      .select({
        checkpoint: schema.checkpoints,
        submission: schema.submissions,
      })
      .from(schema.checkpoints)
      .innerJoin(schema.submissions, eq(schema.submissions.id, schema.checkpoints.submissionId))
      .where(
        and(
          eq(schema.submissions.weekId, week.id),
          eq(schema.submissions.userId, scope.userId),
          eq(schema.submissions.type, "checkpoint"),
        ),
      )
      .orderBy(desc(schema.checkpoints.createdAt));

    return rows.map((r) => ({
      id: r.checkpoint.id,
      submissionId: r.checkpoint.submissionId,
      createdAt: r.checkpoint.createdAt,
      expiresAt: r.checkpoint.expiresAt,
      rubricVersion: r.checkpoint.rubricVersion,
      modelVersion: r.checkpoint.modelVersion,
    }));
  });

  // -------------------------------------------------------------------------
  // GET /api/checkpoints/:id — fetch a single checkpoint report.
  //
  // Students see only their own. Graders see everything in their cohort.
  // Admins see everything. Cross-cohort access returns 403.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/checkpoints/:id", async (request, reply) => {
    const scope = await requireCohortScope(request, reply);
    if (!scope) return;
    const db = getDb();
    const rows = await db
      .select({
        checkpoint: schema.checkpoints,
        submission: schema.submissions,
        week: schema.weeks,
      })
      .from(schema.checkpoints)
      .innerJoin(schema.submissions, eq(schema.submissions.id, schema.checkpoints.submissionId))
      .innerJoin(schema.weeks, eq(schema.weeks.id, schema.submissions.weekId))
      .where(eq(schema.checkpoints.id, request.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "checkpoint_not_found" });

    if (!(await assertCohortMatch(reply, scope, row.week.cohortId))) return;
    if (scope.role === "student" && row.submission.userId !== scope.userId) {
      return reply.code(403).send({ error: "cohort_scope_violation" });
    }
    return {
      id: row.checkpoint.id,
      submissionId: row.checkpoint.submissionId,
      report: row.checkpoint.report,
      sonarMetrics: row.checkpoint.sonarMetrics,
      rubricVersion: row.checkpoint.rubricVersion,
      promptVersion: row.checkpoint.promptVersion,
      modelVersion: row.checkpoint.modelVersion,
      expiresAt: row.checkpoint.expiresAt,
      createdAt: row.checkpoint.createdAt,
    };
  });

  // -------------------------------------------------------------------------
  // Admin routes
  // -------------------------------------------------------------------------
  app.post("/api/admin/cohorts", async (request, reply) => {
    const scope = await requireRole(request, reply, ["admin"]);
    if (!scope) return;
    const parsed = CreateCohortSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const db = getDb();
    const [row] = await db
      .insert(schema.cohorts)
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate ?? null,
        maxStudents: parsed.data.maxStudents ?? 100,
      })
      .returning();
    return reply.code(201).send(row);
  });

  app.post<{ Params: { id: string } }>("/api/admin/cohorts/:id/weeks", async (request, reply) => {
    const scope = await requireRole(request, reply, ["admin"]);
    if (!scope) return;
    const parsed = CreateWeekSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    // Phase 8 hardening — validate rubric YAML syntax and shape.
    // Parse the YAML via js-yaml (catches tab/indent errors), then
    // verify it conforms to RubricSchema from @kiln/shared.
    let parsedRubric: unknown;
    try {
      parsedRubric = yaml.load(parsed.data.rubricYaml);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "rubric_yaml_invalid", message: (err as Error).message });
    }
    const rubricCheck = RubricSchema.safeParse(parsedRubric);
    if (!rubricCheck.success) {
      return reply
        .code(400)
        .send({ error: "rubric_schema_invalid", issues: rubricCheck.error.issues });
    }
    const db = getDb();
    const [row] = await db
      .insert(schema.weeks)
      .values({
        cohortId: request.params.id,
        weekNumber: parsed.data.weekNumber,
        title: parsed.data.title,
        projectSlug: parsed.data.projectSlug ?? null,
        rubricYaml: parsed.data.rubricYaml,
        rubricVersion: parsed.data.rubricVersion ?? null,
        templateRepoUrl: parsed.data.templateRepoUrl ?? null,
        visibleChaosYaml: parsed.data.visibleChaosYaml ?? null,
      })
      .returning();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string; n: string } }>(
    "/api/admin/cohorts/:id/weeks/:n/hidden-chaos",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin"]);
      if (!scope) return;
      const parsed = HiddenChaosPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const weekNumber = Number(request.params.n);
      if (!Number.isFinite(weekNumber)) {
        return reply.code(400).send({ error: "invalid_week_number" });
      }
      const db = getDb();
      const [week] = await db
        .select()
        .from(schema.weeks)
        .where(
          and(
            eq(schema.weeks.cohortId, request.params.id),
            eq(schema.weeks.weekNumber, weekNumber),
          ),
        )
        .limit(1);
      if (!week) return reply.code(404).send({ error: "week_not_found" });
      if (!week.visibleChaosYaml) {
        return reply.code(400).send({ error: "week_has_no_visible_profile" });
      }
      const validation = validateHiddenAgainstVisible(
        week.visibleChaosYaml,
        parsed.data.hiddenChaosYaml,
      );
      if (!validation.ok) {
        return reply.code(400).send({ error: "hidden_profile_invalid", issues: validation.errors });
      }
      await db
        .update(schema.weeks)
        .set({ hiddenChaosYaml: parsed.data.hiddenChaosYaml })
        .where(eq(schema.weeks.id, week.id));
      return { status: "updated" };
    },
  );

  app.post<{ Params: { id: string } }>("/api/admin/cohorts/:id/members", async (request, reply) => {
    const scope = await requireRole(request, reply, ["admin"]);
    if (!scope) return;
    const parsed = AddMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const db = getDb();
    let [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, parsed.data.email))
      .limit(1);
    if (!user) {
      [user] = await db
        .insert(schema.users)
        .values({
          email: parsed.data.email,
          name: parsed.data.name,
          role: parsed.data.role,
        })
        .returning();
    }
    if (!user) return reply.code(500).send({ error: "user_upsert_failed" });
    const [member] = await db
      .insert(schema.cohortMembers)
      .values({ userId: user.id, cohortId: request.params.id, role: parsed.data.role })
      .onConflictDoNothing()
      .returning();
    return reply.code(201).send({ user, member });
  });

  app.get<{ Params: { id: string } }>(
    "/api/admin/cohorts/:id/submissions",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin", "grader"]);
      if (!scope) return;
      if (!(await assertCohortMatch(reply, scope, request.params.id))) return;
      const db = getDb();
      const rows = await db
        .select({
          submission: schema.submissions,
          week: schema.weeks,
        })
        .from(schema.submissions)
        .innerJoin(schema.weeks, eq(schema.weeks.id, schema.submissions.weekId))
        .where(eq(schema.weeks.cohortId, request.params.id));
      return rows;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/cohorts/:id/analytics",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin", "grader"]);
      if (!scope) return;
      if (!(await assertCohortMatch(reply, scope, request.params.id))) return;
      const db = getDb();
      const rows = await db
        .select({ score: schema.gradingResults.overallScore })
        .from(schema.gradingResults)
        .innerJoin(
          schema.submissions,
          eq(schema.submissions.id, schema.gradingResults.submissionId),
        )
        .innerJoin(schema.weeks, eq(schema.weeks.id, schema.submissions.weekId))
        .where(eq(schema.weeks.cohortId, request.params.id));
      const n = rows.length;
      const avg = n > 0 ? rows.reduce((a, r) => a + r.score, 0) / n : 0;
      return { cohortId: request.params.id, count: n, averageScore: avg };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/admin/cohorts/:id/checkpoint-config",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin"]);
      if (!scope) return;
      const parsed = CheckpointConfigPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const db = getDb();
      const [cohort] = await db
        .select()
        .from(schema.cohorts)
        .where(eq(schema.cohorts.id, request.params.id))
        .limit(1);
      if (!cohort) return reply.code(404).send({ error: "cohort_not_found" });
      const mergedConfig = { ...(cohort.config ?? {}), ...parsed.data };
      await db
        .update(schema.cohorts)
        .set({ config: mergedConfig })
        .where(eq(schema.cohorts.id, cohort.id));
      return { status: "updated", config: mergedConfig };
    },
  );

  // -------------------------------------------------------------------------
  // Admin usage analytics — Phase 7 §2 (lines 1084-1092). Implementation
  // lives in routes/admin/usage.ts.
  // -------------------------------------------------------------------------
  registerAdminUsageRoutes(app);

  // -------------------------------------------------------------------------
  // Admin dispatch — Phase 7.5. CRUD + observability + test/redispatch.
  // Implementation lives in routes/admin/dispatch.ts.
  // -------------------------------------------------------------------------
  await registerAdminDispatchRoutes(app);

  return app;
}

// Allow test helpers to reach the scope extractor without re-importing.
export type { CohortScope };

async function main(): Promise<void> {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 4000);
  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("server.ts") || entry.endsWith("server.js")) {
  void main();
}
