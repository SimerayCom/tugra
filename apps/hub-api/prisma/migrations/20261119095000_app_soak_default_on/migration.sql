-- New apps default to a 30 s post-cutover soak on zero-downtime rolling deploys.
-- metadata-only; existing rows are deliberately NOT backfilled, so every existing app (including an explicit 0) is unchanged.
ALTER TABLE "Application" ALTER COLUMN "postCutoverSoakSec" SET DEFAULT 30;
