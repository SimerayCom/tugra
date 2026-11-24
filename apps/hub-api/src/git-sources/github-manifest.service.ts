import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPrivateKey, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { GitSourcesService, type GitSourceView } from "./git-sources.service";
import type { GithubInstallationInput, GithubManifestCompleteInput, GithubManifestStartInput } from "./dto";
import {
  buildManifest,
  hashState,
  installUrl,
  isPubliclyReachable,
  manifestPostUrl,
  newSetupState,
  sanitizeAppName,
  SETUP_TTL_MS,
  type GithubManifest,
} from "./github-manifest";

const GH_API = "https://api.github.com";
const GH_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tugra-hub" };
const GH_TIMEOUT_MS = 15_000;
/** Setup tickets are only useful for minutes; rows older than this are swept on the next start. */
const SETUP_RETENTION_MS = 24 * 3_600_000;

/** GitHub could not be reached or answered 5xx: nothing was created there, so the single-use ticket is given back. */
class GithubTransientError extends BadRequestException {}

export interface ManifestStartView {
  /** Where the browser POSTs the manifest (github.com, or the organization's settings). Carries our `state`. */
  postUrl: string;
  manifest: GithubManifest;
  /** false when the hub is not publicly reachable: GitHub is told not to deliver webhooks (push-to-deploy needs a public hub URL). */
  webhookActive: boolean;
}

interface ConvertedApp {
  id?: number;
  slug?: string;
  name?: string;
  html_url?: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string | null;
  pem?: string;
}

/**
 * GitHub App Manifest flow ("Connect GitHub"): start (Tugra pre-fills name, permissions, webhook URL and redirect pages)
 * → the user clicks Create on GitHub → complete (code → App id, private key, webhook secret, stored encrypted) →
 * the user installs the App → captureInstallation (installation id from the setup redirect).
 *
 * Security: every step is bound to a server-side ticket (only the SHA-256 of `state` is stored) that is tied to the
 * user who started the flow, expires after {@link SETUP_TTL_MS} and is claimed atomically, so it works exactly once and
 * never for another account. Team scope + the `integrations` permission are re-checked at every step. The private key
 * and secrets are encrypted at rest, never returned, never logged, and never part of an error message.
 */
@Injectable()
export class GithubManifestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly sources: GitSourcesService,
    private readonly config: ConfigService,
  ) {}

  private webBase(): string {
    return (this.config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3001").replace(/\/+$/, "");
  }

  private async requireShareRight(userId: string, shared: boolean): Promise<void> {
    if (!shared) return;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { isInstanceOwner: true } });
    if (!u?.isInstanceOwner) throw new ForbiddenException("only the instance owner can share a git source with every team");
  }

  private async gh<T>(path: string, init: RequestInit & { jwt?: string } = {}): Promise<T> {
    return (await this.ghCall<T>(path, init)).data;
  }

  /** Like {@link gh}, but a failure says whether it was transient (GitHub unreachable or a 5xx) so the caller can let the user retry. */
  private async ghCall<T>(path: string, init: RequestInit & { jwt?: string } = {}): Promise<{ data: T }> {
    const { jwt, ...rest } = init;
    let res: Response;
    try {
      res = await fetch(`${GH_API}${path}`, {
        ...rest,
        headers: { ...GH_HEADERS, ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
        signal: AbortSignal.timeout(GH_TIMEOUT_MS),
      });
    } catch {
      throw new GithubTransientError("github: could not be reached — try again");
    }
    if (res.status >= 500) throw new GithubTransientError(`github: temporarily unavailable (HTTP ${res.status}) — try again`);
    if (!res.ok) throw new BadRequestException(`github: request failed (HTTP ${res.status})`);
    return { data: (await res.json()) as T };
  }

  private async mint(userId: string, kind: "manifest" | "install", t: { teamId: string; sourceId: string; name?: string | null; sharedAllTeams?: boolean }): Promise<string> {
    const { state, stateHash } = newSetupState();
    await this.prisma.gitSourceSetup.create({
      data: { stateHash, kind, userId, teamId: t.teamId, sourceId: t.sourceId, name: t.name ?? null, sharedAllTeams: t.sharedAllTeams ?? false, expiresAt: new Date(Date.now() + SETUP_TTL_MS) },
    });
    return state;
  }

  /** Claim a ticket: it must exist for THIS user and kind, be unexpired and unused; claiming is atomic (single use). */
  private async claim(userId: string, state: string, kind: "manifest" | "install") {
    const t = await this.prisma.gitSourceSetup.findUnique({ where: { stateHash: hashState(state) } });
    // Same message for unknown / foreign / wrong kind: nothing to learn about other users' tickets.
    if (!t || t.kind !== kind || t.userId !== userId) throw new BadRequestException("invalid or expired state — start again");
    const r = await this.prisma.gitSourceSetup.updateMany({ where: { id: t.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (r.count !== 1) throw new BadRequestException("invalid or expired state — start again");
    return t;
  }

  /** Step 1: authorize, remember the flow, and hand the browser the manifest to POST to GitHub. */
  async start(userId: string, input: GithubManifestStartInput): Promise<ManifestStartView> {
    await this.access.requirePermission(userId, input.teamId, "integrations");
    await this.requireShareRight(userId, input.sharedAllTeams === true);
    await this.prisma.gitSourceSetup.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - SETUP_RETENTION_MS) } } });
    const sourceId = randomUUID();
    const name = sanitizeAppName(input.name, sourceId.slice(0, 6));
    const state = await this.mint(userId, "manifest", { teamId: input.teamId, sourceId, name, sharedAllTeams: input.sharedAllTeams });
    const hubBase = this.sources.hubBase();
    const manifest = buildManifest({ name, hubBase, webBase: this.webBase(), sourceId, anyAccount: input.anyAccount === true });
    await this.audit.log({ actor: userId, action: "git_source.manifest_start", target: sourceId, meta: { org: input.org ?? null } });
    return { postUrl: manifestPostUrl(input.org, state), manifest, webhookActive: isPubliclyReachable(hubBase) };
  }

  /** Step 2: GitHub redirected back with `code`. Exchange it for the App's credentials and store them encrypted. */
  async complete(userId: string, input: GithubManifestCompleteInput): Promise<{ source: GitSourceView; installUrl: string }> {
    const t = await this.claim(userId, input.state, "manifest");
    await this.access.requirePermission(userId, t.teamId, "integrations");
    await this.requireShareRight(userId, t.sharedAllTeams);
    let app: ConvertedApp;
    try {
      app = await this.gh<ConvertedApp>(`/app-manifests/${encodeURIComponent(input.code)}/conversions`, { method: "POST" });
    } catch (e) {
      if (e instanceof GithubTransientError) {
        // Nothing was created on GitHub: hand the ticket back so "try again" works without starting over.
        await this.prisma.gitSourceSetup.updateMany({ where: { id: t.id }, data: { usedAt: null } });
        throw e;
      }
      // The code is spent or expired. If the App was already created on github.com its name is taken, so say so.
      throw new BadRequestException("github: this link was already used or has expired — if the App now exists on GitHub, delete it there and start again");
    }
    if (app.id === undefined || !app.slug || !app.pem) throw new BadRequestException("github: the App could not be created — start again");
    try {
      createPrivateKey(app.pem);
    } catch {
      throw new BadRequestException("github: returned an unreadable private key — start again");
    }
    let row;
    try {
      row = await this.prisma.gitSource.create({
        data: {
          id: t.sourceId,
          teamId: t.teamId,
          name: t.name || app.name || app.slug,
          provider: "github",
          appId: String(app.id),
          appSlug: app.slug,
          htmlUrl: app.html_url ?? null,
          clientId: app.client_id ?? null,
          clientSecretEnc: app.client_secret ? this.crypto.encrypt(app.client_secret) : null,
          privateKeyEnc: this.crypto.encrypt(app.pem),
          webhookSecretEnc: app.webhook_secret ? this.crypto.encrypt(app.webhook_secret) : null,
          sharedAllTeams: t.sharedAllTeams,
        },
        include: { installations: true },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") throw new ConflictException("this GitHub App is already connected to the team");
      throw e;
    }
    await this.audit.log({ actor: userId, action: "git_source.create", target: row.id, meta: { via: "manifest" } }); // no secrets
    const state = await this.mint(userId, "install", { teamId: t.teamId, sourceId: row.id });
    return { source: this.sources.viewOf(row, true), installUrl: installUrl(app.slug, state) };
  }

  /** Step 3: GitHub redirected back from the install page with `installation_id`. Record the installation (with who
   *  it is installed for), after proving with the App's own key that the installation really belongs to this App. */
  async captureInstallation(userId: string, input: GithubInstallationInput): Promise<GitSourceView> {
    const t = await this.claim(userId, input.state, "install");
    return this.recordInstallation(userId, t.sourceId, t.teamId, input.installationId);
  }

  private async recordInstallation(userId: string, sourceId: string, teamId: string, installationId: string): Promise<GitSourceView> {
    await this.access.requirePermission(userId, teamId, "integrations");
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId } });
    if (!s || s.teamId !== teamId || s.provider !== "github" || !s.appId || !s.privateKeyEnc) throw new NotFoundException("git source not found");
    const jwt = this.sources.appJwt(s.appId, this.crypto.decrypt(s.privateKeyEnc));
    const inst = await this.gh<{ id?: number; app_id?: number; account?: { login?: string; type?: string; avatar_url?: string } | null }>(`/app/installations/${encodeURIComponent(installationId)}`, { jwt });
    if (String(inst.app_id) !== s.appId) throw new BadRequestException("this installation does not belong to the connected GitHub App");
    const account = { accountLogin: inst.account?.login ?? null, accountType: inst.account?.type ?? null, avatarUrl: inst.account?.avatar_url ?? null };
    await this.prisma.gitSourceInstallation.upsert({
      where: { sourceId_installationId: { sourceId, installationId } },
      create: { sourceId, installationId, ...account },
      update: account,
    });
    if (!s.installationId) await this.prisma.gitSource.update({ where: { id: sourceId }, data: { installationId } });
    this.sources.dropTokens(sourceId);
    await this.audit.log({ actor: userId, action: "git_source.install", target: sourceId, meta: { account: account.accountLogin } });
    const row = await this.prisma.gitSource.findUniqueOrThrow({ where: { id: sourceId }, include: { installations: { orderBy: { createdAt: "asc" } } } });
    return this.sources.viewOf(row, true);
  }

  /** Install the same App on another account or organization (multiple installations). */
  async startInstall(userId: string, sourceId: string): Promise<{ installUrl: string }> {
    const s = await this.prisma.gitSource.findUnique({ where: { id: sourceId } });
    if (!s || s.provider !== "github" || !s.appId || !s.privateKeyEnc) throw new NotFoundException("git source not found");
    await this.access.requirePermission(userId, s.teamId, "integrations");
    let slug = s.appSlug;
    if (!slug) {
      const app = await this.gh<{ slug?: string }>("/app", { jwt: this.sources.appJwt(s.appId, this.crypto.decrypt(s.privateKeyEnc)) });
      if (!app.slug) throw new BadRequestException("github: could not read the App");
      slug = app.slug;
      await this.prisma.gitSource.update({ where: { id: sourceId }, data: { appSlug: slug } });
    }
    const state = await this.mint(userId, "install", { teamId: s.teamId, sourceId });
    return { installUrl: installUrl(slug, state) };
  }
}
