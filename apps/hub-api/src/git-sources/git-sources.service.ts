import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createPrivateKey, createSign } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { filterByQuery } from "../common/query-filter";
import { gitUrlHost, isSshGitUrl } from "../deploy/deploy-script";
import type { CreateGitSourceInput, CreateGithubAppSourceInput, CreateTokenSourceInput, UpsertGitSourceForImportInput } from "./dto";
import { GiteaClient, apiUrlHost, isTokenKind, normalizeApiUrl, parseRepoFullName, type GitKind, type TokenGitKind } from "./gitea-client";

const GH_API = "https://api.github.com";
const GH_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export interface GitSourceView {
  id: string;
  name: string;
  teamId: string;
  /** Kind discriminator: github | gitea | forgejo | codeberg (same value as `kind`, kept for older clients). */
  provider: string;
  kind: GitKind;
  /** GitHub App id (github only; null for a token source). */
  appId: string | null;
  appSlug: string | null;
  installationId: string | null;
  htmlUrl: string | null;
  /** Token providers: the instance base URL. null for github. */
  apiUrl: string | null;
  /** A credential is stored (GitHub App key or access token). The credential itself is never returned. */
  hasToken: boolean;
  createdAt: Date;
  canWrite: boolean;
}

export interface RepoView {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface BranchView {
  name: string;
}

/** The only host a source's credential may ever be sent to: github.com for a GitHub App, the instance host for a
 *  token source. Pins the clone credential to its own host so a mis-set `gitUrl` can never exfiltrate it. */
export function sourceCloneHost(s: { provider: string; apiUrl: string | null }): string {
  return isTokenKind(s.provider) && s.apiUrl ? apiUrlHost(s.apiUrl) : "github.com";
}

function b64url(s: string | Buffer): string {
  return (typeof s === "string" ? Buffer.from(s) : s).toString("base64url");
}

@Injectable()
export class GitSourcesService {
  /** sourceId → short-lived installation token cache. */
  private readonly tokenCache = new Map<string, { token: string; exp: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  private view(s: {
    id: string; name: string; teamId: string; provider: string; appId: string | null;
    appSlug: string | null; installationId: string | null; htmlUrl: string | null; createdAt: Date;
    apiUrl?: string | null; tokenEnc?: string | null; privateKeyEnc?: string | null;
  }, canWrite: boolean): GitSourceView {
    return {
      id: s.id, name: s.name, teamId: s.teamId, provider: s.provider, kind: s.provider as GitKind, appId: s.appId,
      appSlug: s.appSlug, installationId: s.installationId, htmlUrl: s.htmlUrl,
      apiUrl: s.apiUrl ?? null, hasToken: !!(s.tokenEnc || s.privateKeyEnc), createdAt: s.createdAt, canWrite,
    };
  }

  async list(userId: string, q?: string): Promise<GitSourceView[]> {
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const teamIds = [...permsByTeam.keys()];
    if (!teamIds.length) return [];
    const rows = await this.prisma.gitSource.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
    });
    const views = rows.map((s) => this.view(s, permsByTeam.get(s.teamId)?.has("integrations") ?? false));
    return filterByQuery(views, q, (g) => [g.name, g.provider, g.appSlug, g.htmlUrl, g.apiUrl]);
  }

  async create(userId: string, dto: CreateGitSourceInput): Promise<GitSourceView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    if (dto.kind && dto.kind !== "github") return this.createTokenSource(userId, dto as CreateTokenSourceInput);
    return this.createGithubApp(userId, dto as CreateGithubAppSourceInput);
  }

  /** Gitea / Forgejo / Codeberg: validate the token against the instance (SSRF-guarded whoami) BEFORE persisting,
   *  then store it encrypted. Only a token that authenticates is ever saved; it is never returned or logged. */
  private async createTokenSource(userId: string, dto: CreateTokenSourceInput): Promise<GitSourceView> {
    const kind: TokenGitKind = dto.kind;
    let apiUrl: string;
    try {
      apiUrl = normalizeApiUrl(kind, dto.apiUrl);
    } catch (e) {
      throw new BadRequestException(scrub((e as Error).message, dto.token));
    }
    try {
      await new GiteaClient(apiUrl, dto.token).whoami();
    } catch (e) {
      throw new BadRequestException(`${kind}: ${scrub((e as Error).message, dto.token)}`);
    }
    const s = await this.prisma.gitSource.create({
      data: {
        teamId: dto.teamId,
        name: dto.name,
        provider: kind,
        apiUrl,
        htmlUrl: apiUrl,
        tokenEnc: this.crypto.encrypt(dto.token),
      },
    });
    await this.audit.log({ actor: userId, action: "git_source.create", target: s.id, meta: { kind } }); // no token
    return this.view(s, true);
  }

  private async createGithubApp(userId: string, dto: CreateGithubAppSourceInput): Promise<GitSourceView> {
    let s;
    try {
      s = await this.prisma.gitSource.create({
        data: {
          teamId: dto.teamId,
          name: dto.name,
          provider: "github",
          appId: dto.appId,
          appSlug: dto.appSlug ?? null,
          clientId: dto.clientId ?? null,
          clientSecretEnc: dto.clientSecret ? this.crypto.encrypt(dto.clientSecret) : null,
          privateKeyEnc: this.crypto.encrypt(dto.privateKey),
          webhookSecretEnc: dto.webhookSecret ? this.crypto.encrypt(dto.webhookSecret) : null,
          installationId: dto.installationId ?? null,
          htmlUrl: dto.htmlUrl ?? null,
        },
      });
    } catch (e) {
      // (teamId, appId) is unique: connecting the same GitHub App twice is a 409, not a raw 500.
      if ((e as { code?: string })?.code === "P2002") throw new ConflictException("this GitHub App is already connected to the team");
      throw e;
    }
    await this.audit.log({ actor: userId, action: "git_source.create", target: s.id });
    return this.view(s, true); // only writers reach here (requirePermission above)
  }

  /** Idempotent carry of a connected GitHub App from an importer into `teamId`, keyed by (teamId, appId): a
   *  retry reuses the row and refreshes its encrypted credentials + installation + metadata. Authorized on the
   *  TARGET team like create(). Rejects a private key Node cannot parse (PKCS#1 and PKCS#8 are both accepted) with
   *  a message that never echoes the key. The user-facing `name` is only set on first create so a later re-import
   *  never clobbers a rename. Returns the GitSource id; no secret is ever returned or audited. */
  async upsertForImport(userId: string, teamId: string, dto: UpsertGitSourceForImportInput): Promise<string> {
    await this.access.requirePermission(userId, teamId, "integrations");
    try {
      createPrivateKey(dto.privateKey);
    } catch {
      throw new BadRequestException("invalid GitHub App private key (expected a PKCS#1 or PKCS#8 PEM)");
    }
    const optional = {
      ...(dto.appSlug ? { appSlug: dto.appSlug } : {}),
      ...(dto.clientId ? { clientId: dto.clientId } : {}),
      ...(dto.clientSecret ? { clientSecretEnc: this.crypto.encrypt(dto.clientSecret) } : {}),
      ...(dto.webhookSecret ? { webhookSecretEnc: this.crypto.encrypt(dto.webhookSecret) } : {}),
      ...(dto.installationId ? { installationId: dto.installationId } : {}),
      ...(dto.htmlUrl ? { htmlUrl: dto.htmlUrl } : {}),
    };
    const privateKeyEnc = this.crypto.encrypt(dto.privateKey);
    const s = await this.prisma.gitSource.upsert({
      where: { teamId_appId: { teamId, appId: dto.appId } },
      create: { teamId, name: dto.name, provider: "github", appId: dto.appId, privateKeyEnc, ...optional },
      update: { privateKeyEnc, ...optional },
      select: { id: true },
    });
    this.tokenCache.delete(s.id); // new credentials/installation → drop any cached installation token
    await this.audit.log({ actor: userId, action: "git_source.import_upsert", target: s.id });
    return s.id;
  }

  async remove(userId: string, id: string): Promise<void> {
    const s = await this.prisma.gitSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("git source not found");
    await this.access.requirePermission(userId, s.teamId, "integrations");
    this.tokenCache.delete(id);
    await this.prisma.gitSource.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "git_source.remove", target: id });
  }

  /** Signed RS256 GitHub App JWT (10-minute window). */
  appJwt(appId: string, privateKeyPem: string): string {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
    const data = `${header}.${payload}`;
    const sig = createSign("RSA-SHA256").update(data).sign(privateKeyPem);
    return `${data}.${b64url(sig)}`;
  }

  /** A fresh (cached) installation access token for cloning private repos. */
  async installationToken(sourceId: string): Promise<string> {
    const cached = this.tokenCache.get(sourceId);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId } });
    if (!s) throw new NotFoundException("git source not found");
    if (isTokenKind(s.provider) || !s.appId || !s.privateKeyEnc) throw new BadRequestException("git source is not a GitHub App");
    if (!s.installationId) throw new BadRequestException("git source is not installed yet");
    const jwt = this.appJwt(s.appId, this.crypto.decrypt(s.privateKeyEnc));
    const res = await fetch(`${GH_API}/app/installations/${s.installationId}/access_tokens`, {
      method: "POST",
      headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new BadRequestException(`github: installation token failed (HTTP ${res.status})`);
    const data = (await res.json()) as { token: string; expires_at: string };
    this.tokenCache.set(sourceId, { token: data.token, exp: new Date(data.expires_at).getTime() });
    return data.token;
  }

  /** Load a source and require the caller to be a member of its team. */
  private async memberSource(userId: string, id: string) {
    const s = await this.prisma.gitSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("git source not found");
    if (!(await this.access.teamRole(userId, s.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    return s;
  }

  /** A guarded Gitea client for a token source (decrypts the token in memory only). */
  private giteaFor(s: { id: string; provider: string; apiUrl: string | null; tokenEnc: string | null }): { client: GiteaClient; token: string } {
    if (!s.apiUrl || !s.tokenEnc) throw new BadRequestException("git source has no stored credential");
    const token = this.crypto.decrypt(s.tokenEnc);
    return { client: new GiteaClient(s.apiUrl, token), token };
  }

  /** Run a provider call, mapping any failure to a 400 whose message never contains the credential. */
  private async guarded<T>(label: string, token: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      throw new BadRequestException(`${label}: ${scrub((e as Error).message, token)}`);
    }
  }

  async listRepos(userId: string, id: string): Promise<RepoView[]> {
    const s = await this.memberSource(userId, id);
    if (isTokenKind(s.provider)) {
      const { client, token } = this.giteaFor(s);
      return this.guarded(s.provider, token, () => client.listRepos());
    }
    const token = await this.installationToken(id);
    const res = await fetch(`${GH_API}/installation/repositories?per_page=100`, {
      headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new BadRequestException(`github: list repos failed (HTTP ${res.status})`);
    const data = (await res.json()) as {
      repositories: { full_name: string; clone_url: string; private: boolean; default_branch?: string | null }[];
    };
    return data.repositories.map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, private: r.private, defaultBranch: r.default_branch ?? null }));
  }

  /** Branches of one repo (`owner/name`) reachable through the source. Dispatches by kind. */
  async listBranches(userId: string, id: string, repoFullName: string): Promise<BranchView[]> {
    const full = parseRepoFullName(repoFullName);
    if (!full) throw new BadRequestException("repo must be owner/name");
    const s = await this.memberSource(userId, id);
    if (isTokenKind(s.provider)) {
      const { client, token } = this.giteaFor(s);
      const names = await this.guarded(s.provider, token, () => client.listBranches(full.owner, full.repo));
      return names.map((name) => ({ name }));
    }
    const token = await this.installationToken(id);
    const res = await fetch(`${GH_API}/repos/${encodeURIComponent(full.owner)}/${encodeURIComponent(full.repo)}/branches?per_page=100`, {
      headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new BadRequestException(`github: list branches failed (HTTP ${res.status})`);
    const data = (await res.json()) as { name: string }[];
    return data.map((b) => ({ name: b.name }));
  }

  /**
   * The clone credential for an app linked to `sourceId`, resolved at deploy time. GitHub App → a fresh
   * installation token; token provider → its decrypted access token. The credential is PINNED to its own host:
   * if the app's repo URL points anywhere else (github.com for an App, the instance host for a token source) the
   * deploy is refused rather than ever sending the secret to a third-party host. The deploy script hands the token
   * to git through GIT_ASKPASS (never argv / the URL / .git/config / logs), so it cannot appear in clone output.
   */
  async cloneToken(sourceId: string, gitUrl: string | null | undefined): Promise<string> {
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId } });
    if (!s) throw new NotFoundException("git source not found");
    // An ssh:// / git@ repo authenticates with its deploy key, not an HTTP token — never a host-mismatch error.
    if (isSshGitUrl(gitUrl ?? "")) return "";
    const want = sourceCloneHost(s);
    const host = gitUrlHost(gitUrl ?? "");
    if (!host || host !== want) {
      throw new BadRequestException(`the linked ${s.provider} source only authenticates ${want} repositories — unlink it or point the repo at ${want}`);
    }
    if (isTokenKind(s.provider)) return this.giteaFor(s).token;
    return this.installationToken(sourceId);
  }
}

/** Remove every occurrence of a secret from a message so an upstream error can never echo it. */
function scrub(message: string, secret: string): string {
  return secret ? message.split(secret).join("***") : message;
}
