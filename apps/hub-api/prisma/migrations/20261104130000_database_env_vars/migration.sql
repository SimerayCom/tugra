-- Add optional encrypted env-vars column to Database (user-set container env, injected at provision).
ALTER TABLE "Database" ADD COLUMN "envEnc" TEXT;
