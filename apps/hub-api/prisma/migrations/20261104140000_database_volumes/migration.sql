-- Add optional extra-volumes column to Database (user-set persistent volumes beyond the data volume).
ALTER TABLE "Database" ADD COLUMN "volumes" JSONB;
