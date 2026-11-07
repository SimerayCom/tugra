import { z } from "zod";
import { TOKEN_GIT_KINDS } from "./gitea-client";

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

/** `GET /git-sources/:id/branches?repo=owner/name` */
export const GitBranchesQuerySchema = z.object({ repo: z.string().min(3).max(300) });
