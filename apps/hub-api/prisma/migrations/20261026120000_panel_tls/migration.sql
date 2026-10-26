-- Panel-TLS (DİLİM 1): the control panel's own HTTPS hostname (opt-in auto-TLS).
-- Additive + nullable: every existing instance stays inert (null = bring-your-own-proxy, unchanged).
ALTER TABLE "InstanceSettings" ADD COLUMN "panelDomain" TEXT;
