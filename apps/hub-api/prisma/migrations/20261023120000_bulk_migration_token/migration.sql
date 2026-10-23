-- Importer one-time migration token (S2). Additive: both columns nullable, no backfill / table rewrite.
-- Only the SHA-256 of the token is stored (mirrors ApiToken.tokenHash); NULL = no live token.
-- AlterTable
ALTER TABLE "BulkOperation" ADD COLUMN     "migrationTokenHash" TEXT,
ADD COLUMN     "migrationTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex (Postgres treats NULLs as distinct, so existing rows with a NULL hash never collide —
-- the same trick as BulkTask_opId_itemRef_key). Index name must be <Model>_<field>_key or migrate diff drifts.
CREATE UNIQUE INDEX "BulkOperation_migrationTokenHash_key" ON "BulkOperation"("migrationTokenHash");
