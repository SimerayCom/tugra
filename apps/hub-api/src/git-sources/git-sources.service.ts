import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createSign } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import type { CreateGitSourceInput } from "./dto";

const GH_API = "https://api.github.com";
const GH_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export interface GitSourceView {
  id: string;
  name: string;
  teamId: string;
  provider: string;
  appId: string;
  appSlug: string | null;
  installationId: string | null;
  htmlUrl: string | null;
  createdAt: Date;
  canWrite: boolean;
}

export interface RepoView {
  fullName: string;
  cloneUrl: string;
  private: boolean;
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
    id: string; name: string; teamId: string; provider: string; appId: string;
    appSlug: string | null; installationId: string | null; htmlUrl: string | null; createdAt: Date;
  }, canWrite: boolean): GitSourceView {
    return {
      id: s.id, name: s.name, teamId: s.teamId, provider: s.provider, appId: s.appId,
      appSlug: s.appSlug, installationId: s.installationId, htmlUrl: s.htmlUrl, createdAt: s.createdAt, canWrite,
    };
  }

  async list(userId: string): Promise<GitSourceView[]> {
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const teamIds = [...permsByTeam.keys()];
    if (!teamIds.length) return [];
    const rows = await this.prisma.gitSource.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((s) => this.view(s, permsByTeam.get(s.teamId)?.has("integrations") ?? false));
  }

  async create(userId: string, dto: CreateGitSourceInput): Promise<GitSourceView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    const s = await this.prisma.gitSource.create({
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
    await this.audit.log({ actor: userId, action: "git_source.create", target: s.id });
    return this.view(s, true); // only writers reach here (requirePermission above)
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

  async listRepos(userId: string, id: string): Promise<RepoView[]> {
    const s = await this.prisma.gitSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("git source not found");
    if (!(await this.access.teamRole(userId, s.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    const token = await this.installationToken(id);
    const res = await fetch(`${GH_API}/installation/repositories?per_page=100`, {
      headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new BadRequestException(`github: list repos failed (HTTP ${res.status})`);
    const data = (await res.json()) as { repositories: { full_name: string; clone_url: string; private: boolean }[] };
    return data.repositories.map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, private: r.private }));
  }
}
