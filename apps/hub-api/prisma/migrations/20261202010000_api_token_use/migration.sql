-- Bounded recent-use history per API token (IP, user agent, tool/route). Never stores the token.
CREATE TABLE "ApiTokenUse" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "action" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ApiTokenUse_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApiTokenUse_tokenId_at_idx" ON "ApiTokenUse"("tokenId", "at");

ALTER TABLE "ApiTokenUse" ADD CONSTRAINT "ApiTokenUse_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ApiToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
