-- Build-time secrets (BuildKit --secret mounts), separate from build args. Additive.
ALTER TABLE "Application" ADD COLUMN "buildSecretsEnc" TEXT;
