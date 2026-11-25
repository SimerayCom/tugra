-- New installs keep the hub and every agent current by default; existing installs keep their setting.
ALTER TABLE "InstanceSettings" ALTER COLUMN "autoUpdate" SET DEFAULT true;
