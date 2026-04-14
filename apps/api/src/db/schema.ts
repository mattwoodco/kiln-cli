import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Multi-cohort data model
// ---------------------------------------------------------------------------

export const cohorts = pgTable("cohorts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  maxStudents: integer("max_students").default(100),
  config: jsonb("config").$type<Record<string, unknown>>().default({
    checkpoint_retention_days: 7,
    checkpoints_enabled: true,
  }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const weeks = pgTable(
  "weeks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cohortId: uuid("cohort_id")
      .references(() => cohorts.id)
      .notNull(),
    weekNumber: integer("week_number").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    projectSlug: varchar("project_slug", { length: 100 }),
    rubricYaml: text("rubric_yaml").notNull(),
    rubricVersion: varchar("rubric_version", { length: 64 }),
    templateRepoUrl: text("template_repo_url"),
    templateOverrides: jsonb("template_overrides").$type<Record<string, unknown>>(),
    // Visible profile is also shipped into the student scaffold as .kiln/chaos-profiles/week-XX.yml
    visibleChaosYaml: text("visible_chaos_yaml"),
    // SERVER-SIDE ONLY. Never returned to student endpoints. Injected into
    // grading pipeline only on stage="final".
    hiddenChaosYaml: text("hidden_chaos_yaml"),
    // Optional early-deadline ISO string used by POST /api/submissions gating.
    earlyDeadline: timestamp("early_deadline"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    uniqueWeek: unique().on(t.cohortId, t.weekNumber),
  }),
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const cohortMembers = pgTable(
  "cohort_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    cohortId: uuid("cohort_id")
      .references(() => cohorts.id)
      .notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    joinedAt: timestamp("joined_at").defaultNow(),
  },
  (t) => ({
    uniqueMembership: unique().on(t.userId, t.cohortId),
  }),
);

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  weekId: uuid("week_id")
    .references(() => weeks.id)
    .notNull(),
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
  submissionId: uuid("submission_id")
    .references(() => submissions.id)
    .notNull(),
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

export const graderOverrides = pgTable("grader_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  gradingResultId: uuid("grading_result_id")
    .references(() => gradingResults.id)
    .notNull(),
  graderId: uuid("grader_id")
    .references(() => users.id)
    .notNull(),
  criterion: varchar("criterion", { length: 100 }).notNull(),
  aiScore: real("ai_score").notNull(),
  humanScore: real("human_score").notNull(),
  rationale: text("rationale").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Checkpoints (Phase 6 will populate the workflow; schema lives here)
// ---------------------------------------------------------------------------

export const checkpoints = pgTable("checkpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id")
    .references(() => submissions.id)
    .notNull(),
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
  sonarMetrics: jsonb("sonar_metrics").$type<Record<string, unknown>>(),
  rubricVersion: varchar("rubric_version", { length: 64 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
  modelVersion: varchar("model_version", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Usage & cost metrics
// ---------------------------------------------------------------------------

export const pipelineUsageEvents = pgTable("pipeline_usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id")
    .references(() => cohorts.id)
    .notNull(),
  weekId: uuid("week_id")
    .references(() => weeks.id)
    .notNull(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  submissionId: uuid("submission_id")
    .references(() => submissions.id)
    .notNull(),
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

export const usageDailyRollups = pgTable(
  "usage_daily_rollups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cohortId: uuid("cohort_id")
      .references(() => cohorts.id)
      .notNull(),
    date: date("date").notNull(),
    pipelineType: varchar("pipeline_type", { length: 20 }).notNull(),
    totalRuns: integer("total_runs").notNull(),
    successfulRuns: integer("successful_runs").notNull(),
    failedRuns: integer("failed_runs").notNull(),
    uniqueStudents: integer("unique_students").notNull(),
    totalInputTokens: bigint("total_input_tokens", { mode: "number" }).notNull(),
    totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).notNull(),
    totalCacheReadTokens: bigint("total_cache_read_tokens", { mode: "number" }).notNull(),
    totalEstimatedCostUsd: real("total_estimated_cost_usd").notNull(),
    avgDurationMs: integer("avg_duration_ms").notNull(),
    p95DurationMs: integer("p95_duration_ms").notNull(),
    avgArtifactStorageBytes: integer("avg_artifact_storage_bytes").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    uniqueRollup: unique().on(t.cohortId, t.date, t.pipelineType),
  }),
);

export const usageAlerts = pgTable("usage_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").references(() => cohorts.id),
  alertType: varchar("alert_type", { length: 50 }).notNull(),
  severity: varchar("severity", { length: 10 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  detail: text("detail").notNull(),
  acknowledgedAt: timestamp("acknowledged_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Artifact dispatch (Phase 7.5 will populate workflow; schema lives here)
// ---------------------------------------------------------------------------

export const dispatchTargets = pgTable(
  "dispatch_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cohortId: uuid("cohort_id")
      .references(() => cohorts.id)
      .notNull(),
    weekId: uuid("week_id").references(() => weeks.id),
    name: varchar("name", { length: 100 }).notNull(),
    url: text("url").notNull(),
    authMode: varchar("auth_mode", { length: 20 }).notNull(),
    authSecretRef: varchar("auth_secret_ref", { length: 200 }),
    artifactSelectors: jsonb("artifact_selectors").$type<string[]>().notNull(),
    transformTemplate: text("transform_template"),
    retryPolicy: jsonb("retry_policy")
      .$type<{ maxAttempts: number; backoffSeconds: number[] }>()
      .notNull()
      .default({
        maxAttempts: 5,
        backoffSeconds: [1, 4, 16, 64, 256],
      }),
    triggerOn: jsonb("trigger_on").$type<string[]>().notNull().default(["final"]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    uniqueTargetName: unique().on(t.cohortId, t.weekId, t.name),
  }),
);

export const dispatchEvents = pgTable("dispatch_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetId: uuid("target_id")
    .references(() => dispatchTargets.id)
    .notNull(),
  submissionId: uuid("submission_id")
    .references(() => submissions.id)
    .notNull(),
  cohortId: uuid("cohort_id")
    .references(() => cohorts.id)
    .notNull(),
  attempt: integer("attempt").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  httpStatus: integer("http_status"),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  payloadBytes: integer("payload_bytes").notNull().default(0),
  responseRef: text("response_ref"),
  createdAt: timestamp("created_at").defaultNow(),
});
