-- CreateTable
CREATE TABLE "DnsCredential" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiTokenEnc" TEXT NOT NULL,
    "cfAccountId" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DnsCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DnsCredential_teamId_idx" ON "DnsCredential"("teamId");

-- AddForeignKey
ALTER TABLE "DnsCredential" ADD CONSTRAINT "DnsCredential_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
