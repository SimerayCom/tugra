-- Per-app SSH deploy key for cloning a private repo over git@/ssh:// — a generated ed25519 keypair.
-- gitSshKeyEnc is the AES-encrypted OpenSSH private key (never returned); gitSshPublicKey is the public
-- line the operator adds to the repo. Additive + nullable, so existing apps are unchanged.

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "gitSshKeyEnc" TEXT,
ADD COLUMN     "gitSshPublicKey" TEXT;
