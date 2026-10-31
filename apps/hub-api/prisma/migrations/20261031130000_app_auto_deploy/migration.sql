-- Per-app push-to-deploy switch (true = a matching push auto-deploys; false = acknowledged but ignored).
ALTER TABLE "Application" ADD COLUMN "autoDeploy" BOOLEAN NOT NULL DEFAULT true;
