/**
 * Phase 7.5 — Admin dispatch routes.
 *
 * Cohort-scoped CRUD + observability + test/redispatch endpoints. All
 * routes require the `admin` role on a JWT and additionally enforce
 * `assertCohortMatch` against the resource cohort.
 *
 * SECURITY:
 *   - `auth_secret` is NEVER accepted in any request body — only
 *     `authSecretRef`. Validation rejects requests that smuggle in
 *     fields like `auth_secret`, `secret`, or `bearer`.
 *   - Test route runs a synthetic dispatch with NO DB writes.
 *   - Redispatch starts a FRESH child workflow; previous `dispatch_events`
 *     rows are preserved.
 */

import { DispatchTargetCreateSchema, DispatchTargetUpdateSchema } from "@kiln/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, schema } from "../../db/index.js";
import { assertCohortMatch, requireRole } from "../../lib/auth.js";
import { getTemporalClient } from "../../lib/temporal.js";

const FORBIDDEN_INLINE_SECRET_KEYS = [
  "auth_secret",
  "authSecret",
  "secret",
  "bearer",
  "bearer_token",
  "authorization",
  "Authorization",
];

function rejectInlineSecrets(body: unknown): { ok: true } | { ok: false; field: string } {
  if (!body || typeof body !== "object") return { ok: true };
  const entries = Object.entries(body as Record<string, unknown>);
  for (const [k] of entries) {
    if (FORBIDDEN_INLINE_SECRET_KEYS.includes(k)) {
      return { ok: false, field: k };
    }
  }
  return { ok: true };
}

const ListEventsQuerySchema = z.object({
  cohort_id: z.string().uuid(),
  target_id: z.string().uuid().optional(),
  submission_id: z.string().uuid().optional(),
  status: z.enum(["pending", "success", "retrying", "failed", "dead_letter"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const RedispatchBodySchema = z.object({
  submissionId: z.string().uuid(),
  targetId: z.string().uuid(),
});

export async function registerAdminDispatchRoutes(app: FastifyInstance): Promise<void> {
  // -----------------------------------------------------------------------
  // GET /api/admin/cohorts/:id/dispatch/targets?week=<weekId>
  // -----------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { week?: string } }>(
    "/api/admin/cohorts/:id/dispatch/targets",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin"]);
      if (!scope) return;
      if (!(await assertCohortMatch(reply, scope, request.params.id))) return;
      const db = getDb();
      const where = request.query.week
        ? and(
            eq(schema.dispatchTargets.cohortId, request.params.id),
            eq(schema.dispatchTargets.weekId, request.query.week),
          )
        : eq(schema.dispatchTargets.cohortId, request.params.id);
      const rows = await db.select().from(schema.dispatchTargets).where(where);
      return rows;
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/admin/cohorts/:id/dispatch/targets
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/admin/cohorts/:id/dispatch/targets",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin"]);
      if (!scope) return;
      if (!(await assertCohortMatch(reply, scope, request.params.id))) return;

      const inlineCheck = rejectInlineSecrets(request.body);
      if (!inlineCheck.ok) {
        return reply.code(400).send({ error: "inline_secret_forbidden", field: inlineCheck.field });
      }

      const parsed = DispatchTargetCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const db = getDb();
      const [row] = await db
        .insert(schema.dispatchTargets)
        .values({
          cohortId: request.params.id,
          weekId: parsed.data.weekId ?? null,
          name: parsed.data.name,
          url: parsed.data.url,
          authMode: parsed.data.authMode,
          authSecretRef: parsed.data.authSecretRef ?? null,
          artifactSelectors: parsed.data.artifactSelectors,
          transformTemplate: parsed.data.transformTemplate ?? null,
          retryPolicy: parsed.data.retryPolicy ?? {
            maxAttempts: 5,
            backoffSeconds: [1, 4, 16, 64, 256],
          },
          triggerOn: parsed.data.triggerOn ?? ["final"],
          enabled: parsed.data.enabled ?? true,
        })
        .returning();
      if (!row) return reply.code(500).send({ error: "target_insert_failed" });
      return reply.code(201).send(row);
    },
  );

  // -----------------------------------------------------------------------
  // PATCH /api/admin/dispatch/targets/:targetId
  // -----------------------------------------------------------------------
  app.patch<{ Params: { targetId: string } }>(
    "/api/admin/dispatch/targets/:targetId",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin"]);
      if (!scope) return;
      const inlineCheck = rejectInlineSecrets(request.body);
      if (!inlineCheck.ok) {
        return reply.code(400).send({ error: "inline_secret_forbidden", field: inlineCheck.field });
      }
      const parsed = DispatchTargetUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const db = getDb();
      const [existing] = await db
        .select()
        .from(schema.dispatchTargets)
        .where(eq(schema.dispatchTargets.id, request.params.targetId))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: "target_not_found" });
      if (!(await assertCohortMatch(reply, scope, existing.cohortId))) return;

      const updates: Partial<typeof schema.dispatchTargets.$inferInsert> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.url !== undefined) updates.url = parsed.data.url;
      if (parsed.data.authMode !== undefined) updates.authMode = parsed.data.authMode;
      if (parsed.data.authSecretRef !== undefined)
        updates.authSecretRef = parsed.data.authSecretRef;
      if (parsed.data.artifactSelectors !== undefined)
        updates.artifactSelectors = parsed.data.artifactSelectors;
      if (parsed.data.transformTemplate !== undefined)
        updates.transformTemplate = parsed.data.transformTemplate;
      if (parsed.data.retryPolicy !== undefined) updates.retryPolicy = parsed.data.retryPolicy;
      if (parsed.data.triggerOn !== undefined) updates.triggerOn = parsed.data.triggerOn;
      if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
      updates.updatedAt = new Date();

      const [row] = await db
        .update(schema.dispatchTargets)
        .set(updates)
        .where(eq(schema.dispatchTargets.id, request.params.targetId))
        .returning();
      return row;
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /api/admin/dispatch/targets/:targetId  (soft delete)
  // -----------------------------------------------------------------------
  app.delete<{ Params: { targetId: string } }>(
    "/api/admin/dispatch/targets/:targetId",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin"]);
      if (!scope) return;
      const db = getDb();
      const [existing] = await db
        .select()
        .from(schema.dispatchTargets)
        .where(eq(schema.dispatchTargets.id, request.params.targetId))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: "target_not_found" });
      if (!(await assertCohortMatch(reply, scope, existing.cohortId))) return;
      await db
        .update(schema.dispatchTargets)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(schema.dispatchTargets.id, request.params.targetId));
      return { status: "soft_deleted" };
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/admin/dispatch/targets/:targetId/test
  // synthetic dispatch — no DB writes, returns preview
  // -----------------------------------------------------------------------
  app.post<{ Params: { targetId: string } }>(
    "/api/admin/dispatch/targets/:targetId/test",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin"]);
      if (!scope) return;
      const db = getDb();
      const [target] = await db
        .select()
        .from(schema.dispatchTargets)
        .where(eq(schema.dispatchTargets.id, request.params.targetId))
        .limit(1);
      if (!target) return reply.code(404).send({ error: "target_not_found" });
      if (!(await assertCohortMatch(reply, scope, target.cohortId))) return;

      // Build a synthetic preview payload. We DO NOT actually perform the
      // HTTP POST in the test endpoint — the spec says return
      // `{httpStatus, latencyMs, previewPayload}` and avoid side effects.
      const previewPayload = {
        kind: "synthetic_test",
        target_id: target.id,
        target_name: target.name,
        cohort_id: target.cohortId,
        student_id: "synthetic-student-id",
        submission_id: "synthetic-submission-id",
        rubric_version: "synthetic",
        artifactSelectors: target.artifactSelectors,
        one_sheet: { overall_score: 85, overall_grade: "B+" },
        ai_usage: {
          total_cost_usd: 0.1234,
          total_input_tokens: 1000,
          total_output_tokens: 500,
          cache_hit_rate: 0.5,
          calls_by_purpose: { "analyze-code": 1, "generate-one-sheet": 2 },
        },
      };
      return {
        httpStatus: 0,
        latencyMs: 0,
        previewPayload,
        note: "synthetic test — no HTTP POST performed, no DB writes",
      };
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/admin/dispatch/events
  // -----------------------------------------------------------------------
  app.get<{ Querystring: Record<string, string> }>(
    "/api/admin/dispatch/events",
    async (request, reply) => {
      const scope = await requireRole(request, reply, ["admin"]);
      if (!scope) return;
      const parsed = ListEventsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
      }
      if (!(await assertCohortMatch(reply, scope, parsed.data.cohort_id))) return;
      const db = getDb();
      const conditions = [eq(schema.dispatchEvents.cohortId, parsed.data.cohort_id)];
      if (parsed.data.target_id) {
        conditions.push(eq(schema.dispatchEvents.targetId, parsed.data.target_id));
      }
      if (parsed.data.submission_id) {
        conditions.push(eq(schema.dispatchEvents.submissionId, parsed.data.submission_id));
      }
      if (parsed.data.status) {
        conditions.push(eq(schema.dispatchEvents.status, parsed.data.status));
      }
      const rows = await db
        .select()
        .from(schema.dispatchEvents)
        .where(and(...conditions))
        .orderBy(desc(schema.dispatchEvents.createdAt))
        .limit(parsed.data.limit ?? 100);
      return rows;
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/admin/dispatch/redispatch
  // Starts a FRESH child workflow. Previous events are preserved.
  // -----------------------------------------------------------------------
  app.post("/api/admin/dispatch/redispatch", async (request, reply) => {
    const scope = await requireRole(request, reply, ["admin"]);
    if (!scope) return;
    const parsed = RedispatchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const db = getDb();
    const [target] = await db
      .select()
      .from(schema.dispatchTargets)
      .where(eq(schema.dispatchTargets.id, parsed.data.targetId))
      .limit(1);
    if (!target) return reply.code(404).send({ error: "target_not_found" });

    const [submission] = await db
      .select({
        id: schema.submissions.id,
        weekId: schema.submissions.weekId,
        cohortId: schema.weeks.cohortId,
      })
      .from(schema.submissions)
      .innerJoin(schema.weeks, eq(schema.weeks.id, schema.submissions.weekId))
      .where(eq(schema.submissions.id, parsed.data.submissionId))
      .limit(1);
    if (!submission) return reply.code(404).send({ error: "submission_not_found" });

    // Cohort scoping: target.cohortId, submission.cohortId, and scope.cohortId
    // must all line up (admin override allowed via assertCohortMatch).
    if (target.cohortId !== submission.cohortId) {
      return reply.code(400).send({ error: "cohort_mismatch" });
    }
    if (!(await assertCohortMatch(reply, scope, target.cohortId))) return;

    const client = await getTemporalClient();
    if (!client) {
      return reply.code(503).send({ error: "temporal_unreachable" });
    }
    const workflowId = `redispatch-${parsed.data.submissionId}-${parsed.data.targetId}-${Date.now()}`;
    try {
      await client.workflow.start("dispatchSingleTarget", {
        taskQueue: "grading",
        workflowId,
        args: [
          {
            target: {
              id: target.id,
              cohortId: target.cohortId,
              weekId: target.weekId,
              name: target.name,
              url: target.url,
              authMode: target.authMode,
              authSecretRef: target.authSecretRef,
              artifactSelectors: target.artifactSelectors,
              transformTemplate: target.transformTemplate,
              retryPolicy: target.retryPolicy,
              triggerOn: target.triggerOn,
              enabled: target.enabled,
              createdAt: target.createdAt?.toISOString() ?? null,
              updatedAt: target.updatedAt?.toISOString() ?? null,
            },
            submissionId: parsed.data.submissionId,
            cohortId: target.cohortId,
          },
        ],
      });
      return reply.code(202).send({ status: "started", workflowId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: "workflow_start_failed", message: msg });
    }
  });
}
