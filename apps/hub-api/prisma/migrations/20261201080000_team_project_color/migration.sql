-- Optional accent colour ("#rrggbb") chosen for a team / project; null keeps the default accent.
ALTER TABLE "Team" ADD COLUMN "color" TEXT;
ALTER TABLE "Project" ADD COLUMN "color" TEXT;
