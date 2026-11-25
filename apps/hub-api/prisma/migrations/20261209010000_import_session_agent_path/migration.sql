-- Agent-path import (Coolify hub takeover): the Coolify team a session reads the settings of, and the owner's own host-match answers.
ALTER TABLE "ImportSession" ADD COLUMN "sourceTeamRef" TEXT;
ALTER TABLE "ImportSession" ADD COLUMN "hostLinks" JSONB;
