-- Preview deployments for GitLab / Gitea-Forgejo / Bitbucket: record which provider's event created the preview and its head commit.
ALTER TABLE "Application" ADD COLUMN "prProvider" TEXT;
ALTER TABLE "Application" ADD COLUMN "prHeadSha" TEXT;
