import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
/** Hard cap on how many installation repositories one resolve reads (20 pages of 100). */
const INSTALLATION_REPO_CAP = 2000;
const COUNT_TTL_MS = 60_000;
const GH_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

/** One account / organization a GitHub App source is installed on. */
export interface InstallationView {
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  avatarUrl: string | null;
}

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
  /** The only host this source's credential authenticates (github.com for a GitHub App, the instance host for a
   *  token source). A repo URL on any other host can't use it, so UIs only offer the source for matching repos. */
  cloneHost: string;
  createdAt: Date;
  canWrite: boolean;
  /** Shared with every team by the instance owner (usable for imports and apps in any team). */
  sharedAllTeams: boolean;
  /** GitHub App: where it is installed (personal account and / or organizations). Empty until the first install. */
  installations: InstallationView[];
  /** GitHub App: the URL GitHub delivers push / pull request events to (set automatically by the manifest flow). */
  webhookUrl: string | null;
  /** GitHub App: a webhook secret is stored. */
  hasWebhook: boolean;
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

/** GitHub says the installation is gone (App uninstalled from that account) or suspended. Distinct from other
 *  failures so one dead installation never takes the whole source's repo list down. */
export class InstallationGoneError extends BadRequestException {
  constructor(readonly installationId: string, status: number) {
    super(`github: installation ${installationId} is no longer available (HTTP ${status}) — remove it or reinstall the App`);
  }
}

function b64url(s: string | Buffer): string {
  return (typeof s === "string" ? Buffer.from(s) : s).toString("base64url");
}

/** The columns of a GitSource row the view needs (plus its installations when loaded). */
export interface SourceRow {
    id: string; name: string; teamId: string; provider: string; appId: string | null;
    appSlug: string | null; installationId: string | null; htmlUrl: string | null; createdAt: Date;
    apiUrl?: string | null; tokenEnc?: string | null; privateKeyEnc?: string | null; sharedAllTeams?: boolean | null;
    webhookSecretEnc?: string | null;
    installations?: { installationId: string; accountLogin: string | null; accountType: string | null; avatarUrl: string | null }[];
}

@Injectable()
export class GitSourcesService {
  /** `sourceId:installationId` → short-lived installation token cache. */
  private readonly tokenCache = new Map<string, { token: string; exp: number }>();
  /** `sourceId` → repository count shown on the source card. */
  private readonly countCache = new Map<string, { count: number; exp: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** Drop every cached installation token of a source (credentials or installations changed, or it was removed). */
  dropTokens(sourceId: string): void {
    for (const k of this.tokenCache.keys()) if (k.startsWith(`${sourceId}:`)) this.tokenCache.delete(k);
    this.countCache.delete(sourceId);
  }

  /** Public origin of the hub (where GitHub delivers webhooks); HUB_PUBLIC_URL, else the panel origin. */
  hubBase(): string {
    const v = this.config?.get<string>("HUB_PUBLIC_URL") || this.config?.get<string>("WEB_PUBLIC_URL") || "http://localhost:3000";
    return v.replace(/\/+$/, "");
  }

  private view(s: SourceRow, canWrite: boolean): GitSourceView {
    const isGithub = !isTokenKind(s.provider);
    return {
      id: s.id, name: s.name, teamId: s.teamId, provider: s.provider, kind: s.provider as GitKind, appId: s.appId,
      appSlug: s.appSlug, installationId: s.installationId, htmlUrl: s.htmlUrl,
      apiUrl: s.apiUrl ?? null, hasToken: !!(s.tokenEnc || s.privateKeyEnc), cloneHost: sourceCloneHost({ provider: s.provider, apiUrl: s.apiUrl ?? null }),
      createdAt: s.createdAt, canWrite, sharedAllTeams: s.sharedAllTeams === true,
      installations: (s.installations ?? []).map((i) => ({ installationId: i.installationId, accountLogin: i.accountLogin, accountType: i.accountType, avatarUrl: i.avatarUrl })),
      webhookUrl: isGithub && s.webhookSecretEnc ? `${this.hubBase()}/webhooks/github/${s.id}` : null,
      hasWebhook: isGithub && !!s.webhookSecretEnc,
    };
  }

  /** Public so the manifest flow renders a row exactly like the list does. */
  viewOf(s: SourceRow, canWrite: boolean): GitSourceView {
    return this.view(s, canWrite);
  }

  async list(userId: string, q?: string): Promise<GitSourceView[]> {
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const teamIds = [...permsByTeam.keys()];
    if (!teamIds.length) return [];
    // The caller's teams' own sources, plus any the instance owner shared with every team (read-only there).
    const rows = await this.prisma.gitSource.findMany({
      where: { OR: [{ teamId: { in: teamIds } }, { sharedAllTeams: true }] },
      orderBy: { createdAt: "desc" },
      include: { installations: { orderBy: { createdAt: "asc" } } },
    });
    const views = rows.map((s) => this.view(s, permsByTeam.get(s.teamId)?.has("integrations") ?? false));
    return filterByQuery(views, q, (g) => [g.name, g.provider, g.appSlug, g.htmlUrl, g.apiUrl]);
  }

  /** Share a source with every team, or stop sharing it. Instance owner only, and they must manage the owning team's
   *  integrations: sharing hands every team read access to the repositories the source can see. Audited. */
  async setSharing(userId: string, id: string, shared: boolean): Promise<GitSourceView> {
    const s = await this.prisma.gitSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("git source not found");
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isInstanceOwner: true } });
    if (!user?.isInstanceOwner) throw new ForbiddenException("only the instance owner can share a git source with every team");
    await this.access.requirePermission(userId, s.teamId, "integrations");
    const row = await this.prisma.gitSource.update({ where: { id }, data: { sharedAllTeams: shared } });
    await this.audit.log({ actor: userId, action: shared ? "git_source.share" : "git_source.unshare", target: id });
    return this.view(row, true);
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
    this.dropTokens(s.id); // new credentials/installation → drop any cached installation token
    await this.audit.log({ actor: userId, action: "git_source.import_upsert", target: s.id });
    return s.id;
  }

  async remove(userId: string, id: string): Promise<void> {
    const s = await this.prisma.gitSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("git source not found");
    await this.access.requirePermission(userId, s.teamId, "integrations");
    this.dropTokens(id);
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

  /** The installations a GitHub App source can mint tokens for: its per-account rows, plus the legacy primary
   *  `installationId` (manual add / older rows) when it has no row of its own. */
  private installationsOf(s: { installationId: string | null; installations?: { installationId: string; accountLogin: string | null }[] }): { installationId: string; accountLogin: string | null }[] {
    const rows = [...(s.installations ?? [])];
    if (s.installationId && !rows.some((r) => r.installationId === s.installationId)) rows.unshift({ installationId: s.installationId, accountLogin: null });
    return rows;
  }

  /** The installation that covers a repo owned by `owner`: the one installed on that account, else the primary. */
  private pickInstallation(s: { installationId: string | null; installations?: { installationId: string; accountLogin: string | null }[] }, owner?: string | null): string | null {
    const all = this.installationsOf(s);
    if (owner) {
      const hit = all.find((i) => i.accountLogin && i.accountLogin.toLowerCase() === owner.toLowerCase());
      if (hit) return hit.installationId;
    }
    return s.installationId ?? all[0]?.installationId ?? null;
  }

  /** A fresh (cached) installation access token for cloning private repos. `installationId` selects one of the App's
   *  installations; by default the primary one. */
  async installationToken(sourceId: string, installationId?: string | null): Promise<string> {
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId }, include: { installations: true } });
    if (!s) throw new NotFoundException("git source not found");
    if (isTokenKind(s.provider) || !s.appId || !s.privateKeyEnc) throw new BadRequestException("git source is not a GitHub App");
    const inst = installationId ?? this.pickInstallation(s);
    if (!inst) throw new BadRequestException("git source is not installed yet");
    if (installationId && !this.installationsOf(s).some((i) => i.installationId === installationId)) throw new BadRequestException("unknown installation for this git source");
    const key = `${sourceId}:${inst}`;
    const cached = this.tokenCache.get(key);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const jwt = this.appJwt(s.appId, this.crypto.decrypt(s.privateKeyEnc));
    const res = await fetch(`${GH_API}/app/installations/${inst}/access_tokens`, {
      method: "POST",
      headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
    });
    if (res.status === 404 || res.status === 403) {
      this.tokenCache.delete(key);
      throw new InstallationGoneError(inst, res.status);
    }
    if (!res.ok) throw new BadRequestException(`github: installation token failed (HTTP ${res.status})`);
    const data = (await res.json()) as { token: string; expires_at: string };
    this.tokenCache.set(key, { token: data.token, exp: new Date(data.expires_at).getTime() });
    return data.token;
  }

  /** Every repository one installation can see (100 per page, capped at {@link INSTALLATION_REPO_CAP}). */
  private async readInstallationRepos(token: string): Promise<RepoView[]> {
    const out: RepoView[] = [];
    for (let page = 1; out.length < INSTALLATION_REPO_CAP && page <= INSTALLATION_REPO_CAP / 100; page++) {
      const res = await fetch(`${GH_API}/installation/repositories?per_page=100&page=${page}`, {
        headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new BadRequestException(`github: list repos failed (HTTP ${res.status})`);
      const data = (await res.json()) as {
        repositories?: { full_name?: string; clone_url?: string; private?: boolean; default_branch?: string | null }[];
        total_count?: number;
      };
      const rows = Array.isArray(data.repositories) ? data.repositories : [];
      for (const r of rows) {
        if (typeof r?.full_name === "string") out.push({ fullName: r.full_name, cloneUrl: r.clone_url ?? `https://github.com/${r.full_name}.git`, private: r.private === true, defaultBranch: r.default_branch ?? null });
      }
      if (rows.length < 100) break;
      if (typeof data.total_count === "number" && out.length >= data.total_count) break;
    }
    return out;
  }

  /** Run `fn` against every live installation of a GitHub App source. An installation GitHub reports as gone
   *  (uninstalled / suspended) is skipped so the others still work; if EVERY installation is gone the error is
   *  rethrown (the source is unusable, which is not the same as "sees nothing"). */
  private async eachInstallation<T>(sourceId: string, fn: (token: string) => Promise<T>): Promise<T[]> {
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId }, include: { installations: true } });
    if (!s) throw new NotFoundException("git source not found");
    const ids = this.installationsOf(s).map((i) => i.installationId);
    if (!ids.length) throw new BadRequestException("git source is not installed yet");
    const out: T[] = [];
    let gone: InstallationGoneError | null = null;
    for (const id of ids) {
      try {
        out.push(await fn(await this.installationToken(sourceId, id)));
      } catch (e) {
        if (!(e instanceof InstallationGoneError)) throw e;
        gone = e;
      }
    }
    if (!out.length && gone) throw gone;
    return out;
  }

  /** Repositories across ALL of a GitHub App source's installations, de-duplicated by name. */
  private async allInstallationRepos(sourceId: string): Promise<RepoView[]> {
    const seen = new Map<string, RepoView>();
    for (const repos of await this.eachInstallation(sourceId, (token) => this.readInstallationRepos(token))) {
      for (const r of repos) if (!seen.has(r.fullName.toLowerCase())) seen.set(r.fullName.toLowerCase(), r);
    }
    return [...seen.values()];
  }

  /** How many repositories one installation can see: a single one-item request reading GitHub's `total_count`. */
  private async readInstallationCount(token: string): Promise<number> {
    const res = await fetch(`${GH_API}/installation/repositories?per_page=1`, { headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new BadRequestException(`github: list repos failed (HTTP ${res.status})`);
    const data = (await res.json()) as { total_count?: number };
    return typeof data.total_count === "number" ? data.total_count : 0;
  }

  /** The repository count shown on a source card, without listing every repository (one small request per
   *  installation; a token source lists once). Cached for a minute per source. Team-checked like {@link listRepos}. */
  async repoCount(userId: string, id: string): Promise<{ count: number }> {
    const s = await this.memberSource(userId, id);
    const hit = this.countCache.get(id);
    if (hit && hit.exp > Date.now()) return { count: hit.count };
    let count: number;
    if (isTokenKind(s.provider)) {
      const { client, token } = this.giteaFor(s);
      count = (await this.guarded(s.provider, token, () => client.listRepos())).length;
    } else {
      count = (await this.eachInstallation(id, (token) => this.readInstallationCount(token))).reduce((a, b) => a + b, 0);
    }
    this.countCache.set(id, { count, exp: Date.now() + COUNT_TTL_MS });
    return { count };
  }

  /** Forget one installation of a GitHub App source (the App was uninstalled on GitHub, or the account is no longer
   *  wanted). Needs the integrations permission on the owning team. If it was the primary installation another one
   *  takes over. Nothing is changed on GitHub. */
  async removeInstallation(userId: string, sourceId: string, installationId: string): Promise<GitSourceView> {
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId }, include: { installations: { orderBy: { createdAt: "asc" } } } });
    if (!s || isTokenKind(s.provider)) throw new NotFoundException("git source not found");
    await this.access.requirePermission(userId, s.teamId, "integrations");
    const hasRow = s.installations.some((i) => i.installationId === installationId);
    if (!hasRow && s.installationId !== installationId) throw new NotFoundException("installation not found");
    if (hasRow) await this.prisma.gitSourceInstallation.delete({ where: { sourceId_installationId: { sourceId, installationId } } });
    const rest = s.installations.filter((i) => i.installationId !== installationId);
    if (s.installationId === installationId) {
      await this.prisma.gitSource.update({ where: { id: sourceId }, data: { installationId: rest[0]?.installationId ?? null } });
    }
    this.dropTokens(sourceId);
    this.countCache.delete(sourceId);
    await this.audit.log({ actor: userId, action: "git_source.installation_remove", target: sourceId, meta: { installationId } });
    const row = await this.prisma.gitSource.findUniqueOrThrow({ where: { id: sourceId }, include: { installations: { orderBy: { createdAt: "asc" } } } });
    return this.view(row, true);
  }

  /** Load a source and require the caller to be a member of its team (or of any team, for a shared source). */
  private async memberSource(userId: string, id: string) {
    const s = await this.prisma.gitSource.findUnique({ where: { id }, include: { installations: true } });
    if (!s) throw new NotFoundException("git source not found");
    if (s.sharedAllTeams) {
      if ((await this.access.permissionsByTeam(userId)).size > 0) return s;
      throw new ForbiddenException("not a member of any team");
    }
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
    return this.allInstallationRepos(id);
  }

  /**
   * Every repository a GitHub App source can see (across all its installations), as lowercase `owner/name`. TEAM-SCOPED by the caller (the
   * importer resolver has already authorized the team) so there is no per-user check here. The call is pinned to
   * api.github.com with the installation token (never a user-supplied host), paginated (100 per page) and capped at
   * 2000 repositories per installation. A non-OK answer throws: the caller treats that source as "unknown", never as "sees nothing".
   * `listRepos` (the user-facing picker) is deliberately untouched.
   */
  async installationRepoSet(sourceId: string): Promise<Set<string>> {
    return new Set((await this.allInstallationRepos(sourceId)).map((r) => r.fullName.toLowerCase()));
  }

  /** Can a token source (Gitea / Forgejo / Codeberg) see `owner/name`? Team-scoped like {@link installationRepoSet}. */
  async tokenSourceCanSee(sourceId: string, owner: string, name: string): Promise<"yes" | "no" | "unknown"> {
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId } });
    if (!s || !isTokenKind(s.provider)) return "unknown";
    const { client } = this.giteaFor(s);
    return client.canSeeRepo(owner, name);
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
    const token = await this.installationToken(id, this.pickInstallation(s, full.owner));
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
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId }, include: { installations: true } });
    if (!s) throw new NotFoundException("git source not found");
    // An ssh:// / git@ repo authenticates with its deploy key, not an HTTP token — never a host-mismatch error.
    if (isSshGitUrl(gitUrl ?? "")) return "";
    const want = sourceCloneHost(s);
    const host = gitUrlHost(gitUrl ?? "");
    if (!host || host !== want) {
      throw new BadRequestException(`the linked ${s.provider} source only authenticates ${want} repositories — unlink it or point the repo at ${want}`);
    }
    if (isTokenKind(s.provider)) return this.giteaFor(s).token;
    return this.installationToken(sourceId, this.pickInstallation(s, gitUrlOwner(gitUrl)));
  }
}

/** The owner (user / organization) segment of an https or scp-style git URL, or null. */
export function gitUrlOwner(gitUrl: string | null | undefined): string | null {
  const m = /^(?:https?:\/\/[^/]+\/|[\w.-]+@[^:]+:|ssh:\/\/[^/]+\/)([^/]+)\/[^/]+/.exec((gitUrl ?? "").trim());
  return m ? m[1] : null;
}

/** Remove every occurrence of a secret from a message so an upstream error can never echo it. */
function scrub(message: string, secret: string): string {
  return secret ? message.split(secret).join("***") : message;
}
