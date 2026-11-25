-- A compose project adopted in place: its name, working dir and config files on the host. Null = not adopted.
ALTER TABLE "Application" ADD COLUMN "composeAdopt" JSONB;
