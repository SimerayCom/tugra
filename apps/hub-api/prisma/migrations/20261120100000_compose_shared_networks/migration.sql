-- Hub-owned extra network attachments for a COMPOSE app's services (never user-compose), so sibling apps can reach a stateful service by a stable alias.
ALTER TABLE "Application" ADD COLUMN "composeNetworks" JSONB;
