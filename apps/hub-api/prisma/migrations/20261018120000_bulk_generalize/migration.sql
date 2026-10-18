-- Generalize BulkOperation/BulkTask for orchestrated, multi-step operations (e.g. the importer executor).
-- Fully additive: every new column is nullable or defaulted, and the legacy kind='command' fan-out path is
-- unchanged (existing rows get kind='command' and empty dependsOn).

-- AlterEnum: add statuses for orchestrated items (safe outside a value-using statement on PG12+).
ALTER TYPE "BulkTaskStatus" ADD VALUE IF NOT EXISTS 'ROLLED_BACK';
ALTER TYPE "BulkTaskStatus" ADD VALUE IF NOT EXISTS 'FAILED_VERIFY';
ALTER TYPE "BulkTaskStatus" ADD VALUE IF NOT EXISTS 'AWAITING_CUTOVER';

-- AlterTable
ALTER TABLE "BulkOperation"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'command',
  ADD COLUMN "planId" TEXT,
  ADD COLUMN "meta" JSONB;

-- AlterTable
ALTER TABLE "BulkTask"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'command',
  ADD COLUMN "itemRef" TEXT,
  ADD COLUMN "resourceType" TEXT,
  ADD COLUMN "resourceId" TEXT,
  ADD COLUMN "result" JSONB,
  ADD COLUMN "steps" JSONB,
  ADD COLUMN "dependsOn" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "compensation" JSONB;
