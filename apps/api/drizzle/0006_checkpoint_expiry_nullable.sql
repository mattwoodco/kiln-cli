-- 0006_checkpoint_expiry_nullable.sql — allow `checkpoints.expires_at` to be
-- NULL so `--persist` checkpoints can opt out of TTL-based cleanup.

ALTER TABLE "checkpoints" ALTER COLUMN "expires_at" DROP NOT NULL;
