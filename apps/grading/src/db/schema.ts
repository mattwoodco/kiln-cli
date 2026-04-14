/**
 * Mirror of the subset of `apps/api` Drizzle schema that the grading worker
 * needs to insert into. Kept separate so `@kiln/grading` does not depend on
 * `@kiln/api` (the API depends on grading via the Temporal client, not the
 * other way round).
 *
 * When the canonical schema in `apps/api/src/db/schema.ts` gets extended,
 * mirror the columns here that the grading activities actually write to.
 */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const cohorts = pgTable("cohorts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>(),
});

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  weekId: uuid("week_id").notNull(),
  type: varchar("type", { length: 20 }).notNull().default("final"),
  stage: varchar("stage", { length: 10 }),
  repoUrl: text("repo_url").notNull(),
  commitSha: varchar("commit_sha", { length: 40 }).notNull(),
  videoUrl: text("video_url"),
  status: varchar("status", { length: 20 }).notNull().default("queued"),
  workflowId: text("workflow_id"),
  submittedAt: timestamp("submitted_at").defaultNow(),
});

export const gradingResults = pgTable("grading_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id").notNull(),
  oneSheet: jsonb("one_sheet").$type<Record<string, unknown>>().notNull(),
  sonarMetrics: jsonb("sonar_metrics").$type<Record<string, unknown>>(),
  overallScore: real("overall_score").notNull(),
  overallGrade: varchar("overall_grade", { length: 2 }).notNull(),
  rubricVersion: varchar("rubric_version", { length: 64 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
  modelVersion: varchar("model_version", { length: 64 }).notNull(),
  proxyVersion: varchar("proxy_version", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const checkpoints = pgTable("checkpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id").notNull(),
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
  sonarMetrics: jsonb("sonar_metrics").$type<Record<string, unknown>>(),
  rubricVersion: varchar("rubric_version", { length: 64 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
  modelVersion: varchar("model_version", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Phase 7.5 — Dispatch tables (mirror)
// ---------------------------------------------------------------------------

export const dispatchTargets = pgTable("dispatch_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  weekId: uuid("week_id"),
  name: varchar("name", { length: 100 }).notNull(),
  url: text("url").notNull(),
  authMode: varchar("auth_mode", { length: 20 }).notNull(),
  authSecretRef: varchar("auth_secret_ref", { length: 200 }),
  artifactSelectors: jsonb("artifact_selectors").$type<string[]>().notNull(),
  transformTemplate: text("transform_template"),
  retryPolicy: jsonb("retry_policy")
    .$type<{ maxAttempts: number; backoffSeconds: number[] }>()
    .notNull(),
  triggerOn: jsonb("trigger_on").$type<string[]>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const dispatchEvents = pgTable("dispatch_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetId: uuid("target_id").notNull(),
  submissionId: uuid("submission_id").notNull(),
  cohortId: uuid("cohort_id").notNull(),
  attempt: integer("attempt").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  httpStatus: integer("http_status"),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  payloadBytes: integer("payload_bytes").notNull().default(0),
  responseRef: text("response_ref"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// pipeline_usage_events (Phase 5)
// ---------------------------------------------------------------------------

export const pipelineUsageEvents = pgTable("pipeline_usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  weekId: uuid("week_id").notNull(),
  userId: uuid("user_id").notNull(),
  submissionId: uuid("submission_id").notNull(),
  pipelineType: varchar("pipeline_type", { length: 20 }).notNull(),
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at"),
  status: varchar("status", { length: 20 }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  llmCalls: jsonb("llm_calls").$type<unknown[]>().notNull(),
  totalInputTokens: integer("total_input_tokens").notNull(),
  totalOutputTokens: integer("total_output_tokens").notNull(),
  totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
  totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),
  totalEstimatedCostUsd: real("total_estimated_cost_usd").notNull(),
  sonarqubeScanDurationMs: integer("sonarqube_scan_duration_ms"),
  dockerBuildDurationMs: integer("docker_build_duration_ms"),
  gitCloneDurationMs: integer("git_clone_duration_ms"),
  artifactStorageBytes: integer("artifact_storage_bytes").notNull().default(0),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
  modelVersion: varchar("model_version", { length: 64 }).notNull(),
  rubricVersion: varchar("rubric_version", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});
