-- Owner-set instance policy: owners/admins must have two-factor authentication enabled.
ALTER TABLE "InstanceSettings" ADD COLUMN "require2faForAdmins" BOOLEAN NOT NULL DEFAULT false;
