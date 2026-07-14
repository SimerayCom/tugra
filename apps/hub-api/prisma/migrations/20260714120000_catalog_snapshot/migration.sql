-- CreateTable
CREATE TABLE "CatalogSnapshot" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "version" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "templateCount" INTEGER NOT NULL,
    "etag" TEXT,
    "signatureVerifiedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogSnapshot_pkey" PRIMARY KEY ("id")
);
