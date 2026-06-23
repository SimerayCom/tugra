-- Build-pack variety (Dokploy parity): Railpack + Heroku/CNB buildpacks.
ALTER TYPE "BuildType" ADD VALUE IF NOT EXISTS 'RAILPACK';
ALTER TYPE "BuildType" ADD VALUE IF NOT EXISTS 'HEROKU';
