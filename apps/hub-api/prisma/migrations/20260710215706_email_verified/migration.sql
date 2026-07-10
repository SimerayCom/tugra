-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- Grandfather every account that predates email verification as already verified, so enabling
-- REQUIRE_EMAIL_VERIFICATION later never locks out existing users. New registrations default to false.
UPDATE "User" SET "emailVerified" = true, "emailVerifiedAt" = "createdAt";
