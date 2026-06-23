-- Build-time environment variables (build args), separate from runtime env.
ALTER TABLE "Application" ADD COLUMN "buildArgsEnc" TEXT;
