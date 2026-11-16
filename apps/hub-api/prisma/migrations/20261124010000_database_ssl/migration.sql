-- P7 grup-7 (R22): a PostgreSQL database can serve TLS (self-signed), so an app whose connection URL carries sslmode=require connects.
-- AlterTable
ALTER TABLE "Database" ADD COLUMN     "ssl" BOOLEAN NOT NULL DEFAULT false;
