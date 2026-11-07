-- In-panel Email settings: SMTP / Resend config on the InstanceSettings singleton. The SMTP password and
-- the Resend API key are stored encrypted (CryptoService) and never returned. mailProvider "none" keeps the
-- MAIL_* env fallback, so existing instances behave exactly as before.
ALTER TABLE "InstanceSettings" ADD COLUMN "mailProvider" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN "mailHost" TEXT,
ADD COLUMN "mailPort" INTEGER,
ADD COLUMN "mailSecure" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "mailUser" TEXT,
ADD COLUMN "mailPassEnc" TEXT,
ADD COLUMN "mailFrom" TEXT,
ADD COLUMN "mailResendKeyEnc" TEXT;
