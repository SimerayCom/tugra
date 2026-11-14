-- Per-server GPU detection snapshot (script probe, sanitized). NULL = never probed (unknown), not "no GPU".
ALTER TABLE "Server" ADD COLUMN     "gpuInventory" JSONB,
ADD COLUMN     "gpuCheckedAt" TIMESTAMP(3);
