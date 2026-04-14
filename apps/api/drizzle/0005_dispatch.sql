-- 0005_dispatch.sql — dispatch_targets + dispatch_events.
-- Phase 7.5 will populate the child workflow; schema is defined here so the
-- grading pipeline can reference it when emitting events.

CREATE TABLE IF NOT EXISTS "dispatch_targets" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "cohort_id" uuid NOT NULL REFERENCES "cohorts"("id"),
    "week_id" uuid REFERENCES "weeks"("id"),
    "name" varchar(100) NOT NULL,
    "url" text NOT NULL,
    "auth_mode" varchar(20) NOT NULL,
    "auth_secret_ref" varchar(200),
    "artifact_selectors" jsonb NOT NULL,
    "transform_template" text,
    "retry_policy" jsonb DEFAULT '{"maxAttempts":5,"backoffSeconds":[1,4,16,64,256]}'::jsonb NOT NULL,
    "trigger_on" jsonb DEFAULT '["final"]'::jsonb NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp DEFAULT now(),
    "updated_at" timestamp DEFAULT now(),
    CONSTRAINT "dispatch_targets_cohort_week_name_unique" UNIQUE ("cohort_id", "week_id", "name")
);

CREATE TABLE IF NOT EXISTS "dispatch_events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "target_id" uuid NOT NULL REFERENCES "dispatch_targets"("id"),
    "submission_id" uuid NOT NULL REFERENCES "submissions"("id"),
    "cohort_id" uuid NOT NULL REFERENCES "cohorts"("id"),
    "attempt" integer NOT NULL,
    "status" varchar(20) NOT NULL,
    "http_status" integer,
    "latency_ms" integer,
    "error" text,
    "payload_bytes" integer DEFAULT 0 NOT NULL,
    "response_ref" text,
    "created_at" timestamp DEFAULT now()
);
