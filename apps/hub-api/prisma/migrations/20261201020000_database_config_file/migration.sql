-- A database's custom engine config file (a Redis redis.conf carried by an import), encrypted at rest.
ALTER TABLE "Database" ADD COLUMN "configFileEnc" TEXT;
