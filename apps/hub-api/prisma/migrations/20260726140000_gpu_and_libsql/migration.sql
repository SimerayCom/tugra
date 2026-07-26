-- AlterEnum
ALTER TYPE "DbEngine" ADD VALUE 'LIBSQL';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "gpus" TEXT;
