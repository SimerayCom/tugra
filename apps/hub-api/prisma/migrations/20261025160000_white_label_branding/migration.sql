-- White-label branding (Pro edition). Owner-set fields on the InstanceSettings singleton that replace the
-- Tugra name/logo/favicon/accent and can hide the "Powered by Tugra" footer. Additive + non-destructive;
-- existing rows get NULLs and hidePoweredBy=false (i.e. the unchanged Tugra defaults). The Pro gate is
-- enforced in the app (read returns defaults below Pro), not in the schema.

-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "brandName" TEXT,
ADD COLUMN     "brandLogoUrl" TEXT,
ADD COLUMN     "brandFaviconUrl" TEXT,
ADD COLUMN     "brandAccentColor" TEXT,
ADD COLUMN     "brandHidePoweredBy" BOOLEAN NOT NULL DEFAULT false;
