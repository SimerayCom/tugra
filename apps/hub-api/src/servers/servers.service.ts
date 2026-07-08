import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, Role, ServerStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  generateEnrollToken,
  generateSeal,
  verifyEd25519,
} from "./agent-auth";
import { normalizeTags } from "../common/tags";
import { isIpv6 } from "../common/observed-ip";

const ENROLL_TTL_MS = 60 * 60 * 1000; // 1 hour
const WRITE_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

export interface ServerView {
  id: string;
  name: string;
  status: ServerStatus;
  teamId: string;
  hostname: string | null;
  publicIp: string | null;
  publicIpv6: string | null;
  os: string | null;
  osVersion: string | null;
  arch: string | null;
  kernel: string | null;
  cpuCores: number | null;
  memTotalBytes: string | null; // BigInt serialized
  uptimeSeconds: number | null; // derived from bootTime
  cleanupEnabled: boolean;
  cleanupIntervalHours: number | null;
  cleanupVolumes: boolean;
  lastCleanupAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  seal: string | null;
  tags: string[];
  role: Role;
  canWrite: boolean;
}

export interface HostInfoInput {
  os: string;
  osVersion: string;
  arch: string;
  kernel: string;
  cpuCores: number;
  memTotalBytes: number;
  bootTime: number; // unix seconds
}

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---- REST (operator-facing) ---------------------------------------------

  async createServer(
    userId: string,
    name: string,
    teamId: string,
    publicUrl?: string,
  ): Promise<{ server: ServerView; enrollToken: string; installCommand: string }> {
    await this.requireTeamRole(userId, teamId, WRITE_ROLES);

    const enrollToken = generateEnrollToken();
    const created = await this.prisma.server.create({
      data: {
        name,
        teamId,
        enrollToken,
        enrollTokenExpiresAt: new Date(Date.now() + ENROLL_TTL_MS),
        status: ServerStatus.PENDING,
      },
    });
    await this.audit.log({
      actor: userId,
      action: "server.create",
      target: created.id,
    });

    return {
      server: this.toView(created, Role.OWNER),
      enrollToken,
      installCommand: this.buildInstallCommand(enrollToken, publicUrl),
    };
  }

  /** The one-line agent install command (enroll token embedded). */
  private buildInstallCommand(token: string, publicUrl?: string): string {
    return `tugra-agent --hub ${this.agentWsUrl(publicUrl)} --token ${token}`;
  }

  /**
   * The install command for an EXISTING server, so the PENDING enroll state can
   * live at a stable /servers/[id] URL (refresh-safe, recoverable). The embedded
   * enroll token is only revealed to a team writer while the server is PENDING
   * and the token has not expired — never via the normal getServer payload.
   */
  async getInstall(
    userId: string,
    id: string,
    publicUrl?: string,
  ): Promise<{ status: ServerStatus; installCommand: string | null; expiresAt: Date | null }> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.requireTeamRole(userId, server.teamId, WRITE_ROLES);
    const valid =
      server.status === ServerStatus.PENDING &&
      !!server.enrollToken &&
      !!server.enrollTokenExpiresAt &&
      server.enrollTokenExpiresAt.getTime() > Date.now();
    return {
      status: server.status,
      installCommand: valid ? this.buildInstallCommand(server.enrollToken!, publicUrl) : null,
      expiresAt: server.enrollTokenExpiresAt,
    };
  }

  /** Mint a fresh enroll token for a still-PENDING server (recover an expired/lost command). */
  async reissueEnroll(
    userId: string,
    id: string,
    publicUrl?: string,
  ): Promise<{ installCommand: string; expiresAt: Date }> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.requireTeamRole(userId, server.teamId, WRITE_ROLES);
    if (server.status !== ServerStatus.PENDING) {
      throw new ConflictException("server already enrolled");
    }
    const enrollToken = generateEnrollToken();
    const expiresAt = new Date(Date.now() + ENROLL_TTL_MS);
    await this.prisma.server.update({
      where: { id },
      data: { enrollToken, enrollTokenExpiresAt: expiresAt },
    });
    await this.audit.log({ actor: userId, action: "server.enroll.reissue", target: id });
    return { installCommand: this.buildInstallCommand(enrollToken, publicUrl), expiresAt };
  }

  /**
   * The ws(s) URL the agent should dial. Prefers the configured HUB_PUBLIC_URL,
   * else the request's public host, else localhost — and maps http→ws/https→wss.
   */
  private agentWsUrl(publicUrl?: string): string {
    const port = process.env.HUB_PORT ?? "3000";
    const base = process.env.HUB_PUBLIC_URL ?? publicUrl ?? `http://localhost:${port}`;
    return `${base.replace(/\/+$/, "").replace(/^http/i, "ws")}/agent`;
  }

  /** The teams the user belongs to (for team pickers, command-center scoping). */
  async listTeamsForUser(
    userId: string,
  ): Promise<{ id: string; name: string; role: Role }[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { team: true },
    });
    return memberships.map((m) => ({
      id: m.team.id,
      name: m.team.name,
      role: m.role,
    }));
  }

  /** Cross-team: every server across ALL the user's team memberships. */
  async listForUser(
    userId: string,
    filter?: { teamId?: string; status?: ServerStatus },
  ): Promise<ServerView[]> {
    const roleByTeam = await this.roleByTeam(userId);
    const teamIds = [...roleByTeam.keys()];
    if (teamIds.length === 0) return [];

    const servers = await this.prisma.server.findMany({
      where: {
        teamId: filter?.teamId
          ? filter.teamId
          : { in: teamIds },
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return servers
      .filter((s) => roleByTeam.has(s.teamId))
      .map((s) => this.toView(s, roleByTeam.get(s.teamId)!));
  }

  async getForUser(userId: string, id: string): Promise<ServerView> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    const role = await this.teamRole(userId, server.teamId);
    if (!role) throw new ForbiddenException("not a member of this team");
    return this.toView(server, role);
  }

  async deleteForUser(userId: string, id: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.requireTeamRole(userId, server.teamId, WRITE_ROLES);
    await this.prisma.server.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "server.delete", target: id });
  }

  async setTags(userId: string, id: string, tags: string[]): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.requireTeamRole(userId, server.teamId, WRITE_ROLES);
    await this.prisma.server.update({
      where: { id },
      data: { tags: normalizeTags(tags) },
    });
    await this.audit.log({ actor: userId, action: "server.tags.update", target: id });
  }

  // ---- agent transport (called by the WS server) --------------------------

  /**
   * Update fields for a freshly observed source IP. No-op when there's no IP or
   * the operator has manually pinned the server's address (so an observation
   * never clobbers a manual override).
   */
  private ipFields(observed: string | null | undefined, currentIpSource: string): Prisma.ServerUpdateInput {
    if (!observed || currentIpSource === "manual") return {};
    return isIpv6(observed)
      ? { publicIpv6: observed }
      : { publicIp: observed, ipSource: "observed" };
  }

  async enroll(input: {
    token: string;
    publicKey: string;
    agentVersion: string;
    hostname: string;
    observedIp?: string | null;
  }): Promise<{ serverId: string; seal: string }> {
    const server = await this.prisma.server.findUnique({
      where: { enrollToken: input.token },
    });
    if (
      !server ||
      server.status !== ServerStatus.PENDING ||
      !server.enrollTokenExpiresAt ||
      server.enrollTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException("invalid or expired enroll token");
    }

    const seal = generateSeal();
    await this.prisma.server.update({
      where: { id: server.id },
      data: {
        seal,
        agentPublicKey: input.publicKey,
        agentVersion: input.agentVersion,
        hostname: input.hostname,
        status: ServerStatus.ONLINE,
        lastSeenAt: new Date(),
        ...this.ipFields(input.observedIp, server.ipSource),
      },
    });
    await this.audit.log({
      actor: `server:${server.id}`,
      action: "agent.enroll",
      target: server.id,
    });
    return { serverId: server.id, seal };
  }

  async authenticate(
    serverId: string,
    nonce: string,
    signature: string,
    observedIp?: string | null,
  ): Promise<boolean> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
    });
    if (!server?.agentPublicKey) return false;
    if (!verifyEd25519(server.agentPublicKey, nonce, signature)) return false;
    // Refresh online status + the observed IP in one write (reconnect may bring a
    // new address — a dynamic IP is tracked on every auth).
    await this.markOnline(serverId, this.ipFields(observedIp, server.ipSource));
    return true;
  }

  async markOnline(serverId: string, extra: Prisma.ServerUpdateInput = {}): Promise<void> {
    await this.prisma.server.update({
      where: { id: serverId },
      data: { status: ServerStatus.ONLINE, lastSeenAt: new Date(), ...extra },
    });
  }

  async markOffline(serverId: string): Promise<void> {
    const s = await this.prisma.server
      .update({
        where: { id: serverId },
        data: { status: ServerStatus.OFFLINE },
      })
      .catch(() => undefined);
    if (s) {
      this.notifications
        .fireForEvent(s.teamId, "server_offline", `🔴 ${s.name} is offline`)
        .catch(() => {});
    }
  }

  async touch(serverId: string): Promise<void> {
    await this.prisma.server
      .update({ where: { id: serverId }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  /** Store/refresh the host hardware+OS inventory (sent on every (re)connect). */
  async saveHostInfo(serverId: string, info: HostInfoInput): Promise<void> {
    await this.prisma.server
      .update({
        where: { id: serverId },
        data: {
          os: info.os || null,
          osVersion: info.osVersion || null,
          arch: info.arch || null,
          kernel: info.kernel || null,
          cpuCores: info.cpuCores || null,
          memTotalBytes: info.memTotalBytes ? BigInt(Math.round(info.memTotalBytes)) : null,
          bootTime: info.bootTime ? new Date(info.bootTime * 1000) : null,
        },
      })
      .catch(() => undefined);
  }

  // ---- helpers ------------------------------------------------------------

  private async roleByTeam(userId: string): Promise<Map<string, Role>> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { teamId: true, role: true },
    });
    return new Map(memberships.map((m) => [m.teamId, m.role]));
  }

  private async teamRole(
    userId: string,
    teamId: string,
  ): Promise<Role | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true },
    });
    return membership?.role ?? null;
  }

  private async requireTeamRole(
    userId: string,
    teamId: string,
    roles: Role[],
  ): Promise<void> {
    const role = await this.teamRole(userId, teamId);
    if (!role || !roles.includes(role)) {
      throw new ForbiddenException("insufficient role for this team");
    }
  }

  private toView(
    s: {
      id: string;
      name: string;
      status: ServerStatus;
      teamId: string;
      hostname: string | null;
      publicIp?: string | null;
      publicIpv6?: string | null;
      os?: string | null;
      osVersion?: string | null;
      arch?: string | null;
      kernel?: string | null;
      cpuCores?: number | null;
      memTotalBytes?: bigint | null;
      bootTime?: Date | null;
      cleanupEnabled?: boolean;
      cleanupIntervalHours?: number | null;
      cleanupVolumes?: boolean;
      lastCleanupAt?: Date | null;
      lastSeenAt: Date | null;
      createdAt: Date;
      seal: string | null;
      tags?: string[];
    },
    role: Role,
  ): ServerView {
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      teamId: s.teamId,
      hostname: s.hostname,
      publicIp: s.publicIp ?? null,
      publicIpv6: s.publicIpv6 ?? null,
      os: s.os ?? null,
      osVersion: s.osVersion ?? null,
      arch: s.arch ?? null,
      kernel: s.kernel ?? null,
      cpuCores: s.cpuCores ?? null,
      memTotalBytes: s.memTotalBytes != null ? s.memTotalBytes.toString() : null,
      uptimeSeconds: s.bootTime
        ? Math.max(0, Math.floor((Date.now() - s.bootTime.getTime()) / 1000))
        : null,
      cleanupEnabled: s.cleanupEnabled ?? false,
      cleanupIntervalHours: s.cleanupIntervalHours ?? null,
      cleanupVolumes: s.cleanupVolumes ?? false,
      lastCleanupAt: s.lastCleanupAt ?? null,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
      seal: s.seal,
      tags: s.tags ?? [],
      role,
      canWrite: WRITE_ROLES.includes(role),
    };
  }
}
