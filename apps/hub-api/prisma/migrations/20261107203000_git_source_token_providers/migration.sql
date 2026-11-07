-- Git sources become kind-discriminated (provider: github | gitea | forgejo | codeberg). Token providers
-- (the Gitea family) carry an instance base URL + an encrypted personal access token and have no GitHub App,
-- so appId and privateKeyEnc become nullable. The unique (teamId, appId) index is unchanged: Postgres treats
-- NULLs as distinct, so any number of token sources per team coexist and existing GitHub rows are unaffected.
ALTER TABLE "GitSource" ADD COLUMN "apiUrl" TEXT,
ADD COLUMN "tokenEnc" TEXT,
ALTER COLUMN "appId" DROP NOT NULL,
ALTER COLUMN "privateKeyEnc" DROP NOT NULL;
