-- First-class Nixpacks install/build/start command overrides (Coolify parity). Additive + nullable: null
-- keeps Nixpacks auto-detection, so existing apps are unchanged. Injected as NIXPACKS_*_CMD build env.
ALTER TABLE "Application" ADD COLUMN "nixpacksInstallCmd" TEXT;
ALTER TABLE "Application" ADD COLUMN "nixpacksBuildCmd" TEXT;
ALTER TABLE "Application" ADD COLUMN "nixpacksStartCmd" TEXT;
