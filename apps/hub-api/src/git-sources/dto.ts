import { z } from "zod";
import { TOKEN_GIT_KINDS } from "./gitea-client";
import { GITHUB_LOGIN_RE } from "./github-manifest";

/** A GitHub App source (the reference provider). `kind` is optional so the pre-existing payload still validates. */
const CreateGithubAppSourceSchema = z.object({
  kind: z.literal("github").optional(),
  name: z.string().min(1),
  teamId: z.string().min(1),
  appId: z.string().min(1),
  privateKey: z.string().min(1), // PEM (PKCS#8 / PKCS#1)
  installationId: z.string().min(1).optional(),
  webhookSecret: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  appSlug: z.string().min(1).optional(),
  htmlUrl: z.string().min(1).optional(),
});

/** A token source for the Gitea family (Gitea / Forgejo / Codeberg). The token is write-only: encrypted at rest
 *  and never returned. `apiUrl` is the instance base URL (required for gitea/forgejo; codeberg is fixed). */
const CreateTokenSourceSchema = z.object({
  kind: z.enum(TOKEN_GIT_KINDS),
  name: z.string().min(1),
  teamId: z.string().min(1),
  apiUrl: z.string().min(1).max(2048).optional(),
  token: z.string().min(1).max(4096),
});

export const CreateGitSourceSchema = z.union([CreateTokenSourceSchema, CreateGithubAppSourceSchema]);
export type CreateGitSourceInput = z.infer<typeof CreateGitSourceSchema>;
export type CreateGithubAppSourceInput = z.infer<typeof CreateGithubAppSourceSchema>;
export type CreateTokenSourceInput = z.infer<typeof CreateTokenSourceSchema>;

/** Importer carry of a connected GitHub App into the TARGET team: the same fields as create, minus teamId (the
 *  executor supplies the authorized target team separately). */
export const UpsertGitSourceForImportSchema = CreateGithubAppSourceSchema.omit({ teamId: true, kind: true });
export type UpsertGitSourceForImportInput = z.infer<typeof UpsertGitSourceForImportSchema>;

/** `PATCH /git-sources/:id/sharing` — instance owner shares a source with every team (or stops). */
export const GitSourceSharingSchema = z.object({ sharedAllTeams: z.boolean() }).strict();
export type GitSourceSharingInput = z.infer<typeof GitSourceSharingSchema>;

/** `GET /git-sources/:id/branches?repo=owner/name` */
export const GitBranchesQuerySchema = z.object({ repo: z.string().min(3).max(300) });

/** `POST /git-sources/github/manifest` — begin the GitHub App manifest flow. `org` creates the App under that
 *  organization instead of the user's own account; `anyAccount` lets it be installed on other accounts too. */
export const GithubManifestStartSchema = z
  .object({
    teamId: z.string().min(1),
    name: z.string().max(80).optional(),
    org: z.string().regex(GITHUB_LOGIN_RE).optional(),
    anyAccount: z.boolean().optional(),
    sharedAllTeams: z.boolean().optional(),
  })
  .strict();
export type GithubManifestStartInput = z.infer<typeof GithubManifestStartSchema>;

/** `POST /git-sources/github/manifest/complete` — the browser came back from GitHub with `code` and our `state`. */
export const GithubManifestCompleteSchema = z.object({ code: z.string().min(1).max(256), state: z.string().min(1).max(256) }).strict();
export type GithubManifestCompleteInput = z.infer<typeof GithubManifestCompleteSchema>;

/** `POST /git-sources/github/installation` — the browser came back from the install page with `installation_id`. */
export const GithubInstallationSchema = z.object({ state: z.string().min(1).max(256), installationId: z.string().regex(/^\d{1,20}$/) }).strict();
export type GithubInstallationInput = z.infer<typeof GithubInstallationSchema>;
