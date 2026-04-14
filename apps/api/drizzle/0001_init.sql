-- 0001_init.sql — core tables
-- Cohorts, weeks, users, cohort_members, submissions, grading_results, grader_overrides.
-- Written idempotently so the file can be re-applied during dev loops.

CREATE TABLE IF NOT EXISTS "cohorts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" varchar(255) NOT NULL,
    "description" text,
    "start_date" date NOT NULL,
    "end_date" date,
    "max_students" integer DEFAULT 100,
    "config" jsonb DEFAULT '{"checkpoint_retention_days":7,"checkpoints_enabled":true}'::jsonb,
    "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "weeks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "cohort_id" uuid NOT NULL REFERENCES "cohorts"("id"),
    "week_number" integer NOT NULL,
    "title" varchar(255) NOT NULL,
    "project_slug" varchar(100),
    "rubric_yaml" text NOT NULL,
    "rubric_version" varchar(64),
    "template_repo_url" text,
    "template_overrides" jsonb,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp DEFAULT now(),
    CONSTRAINT "weeks_cohort_id_week_number_unique" UNIQUE ("cohort_id", "week_number")
);

CREATE TABLE IF NOT EXISTS "users" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "email" varchar(255) UNIQUE NOT NULL,
    "name" varchar(255) NOT NULL,
    "role" varchar(20) NOT NULL,
    "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "cohort_members" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "users"("id"),
    "cohort_id" uuid NOT NULL REFERENCES "cohorts"("id"),
    "role" varchar(20) NOT NULL,
    "joined_at" timestamp DEFAULT now(),
    CONSTRAINT "cohort_members_user_id_cohort_id_unique" UNIQUE ("user_id", "cohort_id")
);

CREATE TABLE IF NOT EXISTS "submissions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "users"("id"),
    "week_id" uuid NOT NULL REFERENCES "weeks"("id"),
    "repo_url" text NOT NULL,
    "commit_sha" varchar(40) NOT NULL,
    "video_url" text,
    "status" varchar(20) DEFAULT 'queued' NOT NULL,
    "workflow_id" text,
    "submitted_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "grading_results" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "submission_id" uuid NOT NULL REFERENCES "submissions"("id"),
    "one_sheet" jsonb NOT NULL,
    "sonar_metrics" jsonb,
    "overall_score" real NOT NULL,
    "overall_grade" varchar(2) NOT NULL,
    "rubric_version" varchar(64) NOT NULL,
    "prompt_version" varchar(64) NOT NULL,
    "model_version" varchar(64) NOT NULL,
    "proxy_version" varchar(64),
    "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "grader_overrides" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "grading_result_id" uuid NOT NULL REFERENCES "grading_results"("id"),
    "grader_id" uuid NOT NULL REFERENCES "users"("id"),
    "criterion" varchar(100) NOT NULL,
    "ai_score" real NOT NULL,
    "human_score" real NOT NULL,
    "rationale" text NOT NULL,
    "created_at" timestamp DEFAULT now()
);
