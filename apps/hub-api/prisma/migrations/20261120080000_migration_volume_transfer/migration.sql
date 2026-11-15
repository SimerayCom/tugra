-- Migration volume stream v2: one row per streamed source volume + one row per committed part.
CREATE TYPE "VolumeTransferState" AS ENUM ('PENDING', 'COPYING', 'COPIED', 'APPLYING', 'DONE', 'FAILED', 'ABORTED');

CREATE TABLE "MigrationVolumeTransfer" (
    "id" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "itemRef" TEXT NOT NULL,
    "destType" TEXT NOT NULL,
    "targetServerId" TEXT NOT NULL,
    "dockerVolume" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "state" "VolumeTransferState" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "partRawBytes" INTEGER NOT NULL,
    "partsDone" INTEGER NOT NULL DEFAULT 0,
    "bytesDone" BIGINT NOT NULL DEFAULT 0,
    "rawBytesDone" BIGINT NOT NULL DEFAULT 0,
    "rawBytesTotal" BIGINT,
    "rawBytesFinal" BIGINT,
    "entries" INTEGER,
    "fingerprint" JSONB,
    "runId" TEXT,
    "lastBeatAt" TIMESTAMP(3),
    "phase" TEXT,
    "bps" BIGINT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationVolumeTransfer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MigrationVolumePart" (
    "transferId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "rawOffset" BIGINT NOT NULL,
    "rawLen" INTEGER NOT NULL,
    "rawSha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationVolumePart_pkey" PRIMARY KEY ("transferId","idx")
);

CREATE UNIQUE INDEX "MigrationVolumeTransfer_opId_itemRef_key" ON "MigrationVolumeTransfer"("opId", "itemRef");
CREATE INDEX "MigrationVolumeTransfer_state_lastBeatAt_idx" ON "MigrationVolumeTransfer"("state", "lastBeatAt");

ALTER TABLE "MigrationVolumeTransfer" ADD CONSTRAINT "MigrationVolumeTransfer_opId_fkey" FOREIGN KEY ("opId") REFERENCES "BulkOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MigrationVolumePart" ADD CONSTRAINT "MigrationVolumePart_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "MigrationVolumeTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
