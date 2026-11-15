-- Envelope keyring for secrets-at-rest key rotation without a restart. Only new, empty tables: existing rows are
-- untouched, and with zero SecretsKey rows the hub behaves exactly as before (the ring is just the .env keys).
CREATE TYPE "SecretsKeyState" AS ENUM ('ACTIVE','DECRYPT_ONLY','RETIRED');

CREATE TABLE "SecretsKey" (
    "id" TEXT NOT NULL,
    "state" "SecretsKeyState" NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "demotedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "SecretsKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SecretsKeyWrap" (
    "keyId" TEXT NOT NULL,
    "rootKeyId" TEXT NOT NULL,
    "wrapped" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretsKeyWrap_pkey" PRIMARY KEY ("keyId","rootKeyId")
);

ALTER TABLE "SecretsKeyWrap" ADD CONSTRAINT "SecretsKeyWrap_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "SecretsKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SecretsKeyring" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretsKeyring_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SecretsKeyring" ("id","updatedAt") VALUES ('singleton', CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
