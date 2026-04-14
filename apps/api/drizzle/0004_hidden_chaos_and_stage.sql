-- 0004_hidden_chaos_and_stage.sql
-- Adds weeks.visible_chaos_yaml / hidden_chaos_yaml / early_deadline,
-- and submissions.stage (early | final | null).

ALTER TABLE "weeks"
    ADD COLUMN IF NOT EXISTS "visible_chaos_yaml" text;

ALTER TABLE "weeks"
    ADD COLUMN IF NOT EXISTS "hidden_chaos_yaml" text;

ALTER TABLE "weeks"
    ADD COLUMN IF NOT EXISTS "early_deadline" timestamp;

ALTER TABLE "submissions"
    ADD COLUMN IF NOT EXISTS "stage" varchar(10);
