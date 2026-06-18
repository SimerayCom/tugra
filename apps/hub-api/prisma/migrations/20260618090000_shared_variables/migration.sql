-- CreateTable
CREATE TABLE "SharedVariable" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedVariable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SharedVariable_teamId_idx" ON "SharedVariable"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedVariable_teamId_key_key" ON "SharedVariable"("teamId", "key");

-- AddForeignKey
ALTER TABLE "SharedVariable" ADD CONSTRAINT "SharedVariable_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
