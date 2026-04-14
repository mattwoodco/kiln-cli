-- 0002_checkpoints.sql — checkpoints table + submissions.type column.

ALTER TABLE "submissions"
    ADD COLUMN IF NOT EXISTS "type" varchar(20) DEFAULT 'final' NOT NULL;

CREATE TABLE IF NOT EXISTS "checkpoints" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "submission_id" uuid NOT NULL REFERENCES "submissions"("id"),
    "report" jsonb NOT NULL,
    "sonar_metrics" jsonb,
    "rubric_version" varchar(64) NOT NULL,
    "prompt_version" varchar(64) NOT NULL,
    "model_version" varchar(64) NOT NULL,
    "expires_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now()
);
