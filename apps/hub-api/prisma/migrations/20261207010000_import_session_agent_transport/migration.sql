-- Coolify hub takeover (lane A): an import session can read its source through the agent on the Coolify host (transport 'agent') instead of an API token.
-- AlterTable
ALTER TABLE "ImportSession" ADD COLUMN     "agentServerId" TEXT,
ADD COLUMN     "sessionKeyEnc" TEXT,
ADD COLUMN     "snapshotEnc" TEXT,
ADD COLUMN     "transport" TEXT NOT NULL DEFAULT 'api';
