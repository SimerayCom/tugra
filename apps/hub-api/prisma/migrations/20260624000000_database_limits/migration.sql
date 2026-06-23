-- Database resource limits + health-check (Coolify parity, mirrors app limits).
ALTER TABLE "Database" ADD COLUMN "healthCmd" TEXT,
ADD COLUMN "memoryMb" INTEGER,
ADD COLUMN "cpus" DOUBLE PRECISION;
