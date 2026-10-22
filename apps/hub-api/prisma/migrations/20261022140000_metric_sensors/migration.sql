-- AlterTable: optional sensor metrics (NULL = host exposes none; additive, no backfill / table rewrite)
ALTER TABLE "Metric" ADD COLUMN     "temp" DOUBLE PRECISION,
ADD COLUMN     "gpuUtil" DOUBLE PRECISION,
ADD COLUMN     "gpuMemUsed" BIGINT,
ADD COLUMN     "gpuMemTotal" BIGINT,
ADD COLUMN     "gpuTemp" DOUBLE PRECISION,
ADD COLUMN     "batteryPct" DOUBLE PRECISION,
ADD COLUMN     "batteryState" TEXT,
ADD COLUMN     "detail" JSONB;
