-- CreateEnum
CREATE TYPE "SwarmStatus" AS ENUM ('NONE', 'FORMING', 'ACTIVE', 'DEGRADED', 'DISSOLVING');

-- CreateEnum
CREATE TYPE "SwarmRole" AS ENUM ('MANAGER', 'WORKER');

-- AlterTable
ALTER TABLE "Cluster" ADD COLUMN     "swarmStatus" "SwarmStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "swarmManagerId" TEXT,
ADD COLUMN     "swarmLastError" TEXT;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "swarmRole" "SwarmRole",
ADD COLUMN     "swarmNodeId" TEXT,
ADD COLUMN     "swarmError" TEXT;
