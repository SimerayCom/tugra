-- Extra per-app resource limits (classic Image/Git apps): swap, PIDs, shm size, CPU weight, CPU pinning.
ALTER TABLE "Application" ADD COLUMN     "memorySwapMb" INTEGER,
ADD COLUMN     "pidsLimit" INTEGER,
ADD COLUMN     "shmSizeMb" INTEGER,
ADD COLUMN     "cpuShares" INTEGER,
ADD COLUMN     "cpusetCpus" TEXT;
