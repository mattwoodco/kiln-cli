-- 0003_usage_metrics.sql — pipeline usage events, daily rollups, alerts.

CREATE TABLE IF NOT EXISTS "pipeline_usage_events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "cohort_id" uuid NOT NULL REFERENCES "cohorts"("id"),
    "week_id" uuid NOT NULL REFERENCES "weeks"("id"),
    "user_id" uuid NOT NULL REFERENCES "users"("id"),
    "submission_id" uuid NOT NULL REFERENCES "submissions"("id"),
    "pipeline_type" varchar(20) NOT NULL,
    "started_at" timestamp NOT NULL,
    "completed_at" timestamp,
    "status" varchar(20) NOT NULL,
    "duration_ms" integer NOT NULL,
    "llm_calls" jsonb NOT NULL,
    "total_input_tokens" integer NOT NULL,
    "total_output_tokens" integer NOT NULL,
    "total_cache_read_tokens" integer DEFAULT 0 NOT NULL,
    "total_cache_write_tokens" integer DEFAULT 0 NOT NULL,
    "total_estimated_cost_usd" real NOT NULL,
    "sonarqube_scan_duration_ms" integer,
    "docker_build_duration_ms" integer,
    "git_clone_duration_ms" integer,
    "artifact_storage_bytes" integer DEFAULT 0 NOT NULL,
    "prompt_version" varchar(64) NOT NULL,
    "model_version" varchar(64) NOT NULL,
    "rubric_version" varchar(64) NOT NULL,
    "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "usage_daily_rollups" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "cohort_id" uuid NOT NULL REFERENCES "cohorts"("id"),
    "date" date NOT NULL,
    "pipeline_type" varchar(20) NOT NULL,
    "total_runs" integer NOT NULL,
    "successful_runs" integer NOT NULL,
    "failed_runs" integer NOT NULL,
    "unique_students" integer NOT NULL,
    "total_input_tokens" bigint NOT NULL,
    "total_output_tokens" bigint NOT NULL,
    "total_cache_read_tokens" bigint NOT NULL,
    "total_estimated_cost_usd" real NOT NULL,
    "avg_duration_ms" integer NOT NULL,
    "p95_duration_ms" integer NOT NULL,
    "avg_artifact_storage_bytes" integer NOT NULL,
    "created_at" timestamp DEFAULT now(),
    CONSTRAINT "usage_daily_rollups_cohort_id_date_pipeline_type_unique"
        UNIQUE ("cohort_id", "date", "pipeline_type")
);

CREATE TABLE IF NOT EXISTS "usage_alerts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "cohort_id" uuid REFERENCES "cohorts"("id"),
    "alert_type" varchar(50) NOT NULL,
    "severity" varchar(10) NOT NULL,
    "title" varchar(255) NOT NULL,
    "detail" text NOT NULL,
    "acknowledged_at" timestamp,
    "created_at" timestamp DEFAULT now()
);
