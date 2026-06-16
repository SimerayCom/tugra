import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Role, ServerStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import {
  generateEnrollToken,
  generateSeal,
  verifyEd25519,
} from "./agent-auth";

const ENROLL_TTL_MS = 60 * 60 * 1000; // 1 hour
const WRITE_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

export interface ServerView {
  id: string;
  name: string;
  status: ServerStatus;
  teamId: string;
  hostname: string | null;
  os: string | null;
  osVersion: string | null;
  arch: string | null;
  kernel: string | null;
  cpuCores: number | null;
  memTotalBytes: string | null; // BigInt serialized
  uptimeSeconds: number | null; // derived from bootTime
  lastSeenAt: Date | null;
  createdAt: Date;
  seal: string | null;
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
  ) {}

  // ---- REST (operator-facing) ---------------------------------------------

  async createServer(
    userId: string,
    name: string,
    teamId: string,
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
      installCommand: `tugra-agent --hub <YOUR_HUB_URL>/agent --token ${enrollToken}`,
    };
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

  // ---- agent transport (called by the WS server) --------------------------

  async enroll(input: {
    token: string;
    publicKey: string;
    agentVersion: string;
    hostname: string;
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
  ): Promise<boolean> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
    });
    if (!server?.agentPublicKey) return false;
    if (!verifyEd25519(server.agentPublicKey, nonce, signature)) return false;
    await this.markOnline(serverId);
    return true;
  }

  async markOnline(serverId: string): Promise<void> {
    await this.prisma.server.update({
      where: { id: serverId },
      data: { status: ServerStatus.ONLINE, lastSeenAt: new Date() },
    });
  }

  async markOffline(serverId: string): Promise<void> {
    await this.prisma.server
      .update({
        where: { id: serverId },
        data: { status: ServerStatus.OFFLINE },
      })
      .catch(() => undefined);
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
      os?: string | null;
      osVersion?: string | null;
      arch?: string | null;
      kernel?: string | null;
      cpuCores?: number | null;
      memTotalBytes?: bigint | null;
      bootTime?: Date | null;
      lastSeenAt: Date | null;
      createdAt: Date;
      seal: string | null;
    },
    role: Role,
  ): ServerView {
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      teamId: s.teamId,
      hostname: s.hostname,
      os: s.os ?? null,
      osVersion: s.osVersion ?? null,
      arch: s.arch ?? null,
      kernel: s.kernel ?? null,
      cpuCores: s.cpuCores ?? null,
      memTotalBytes: s.memTotalBytes != null ? s.memTotalBytes.toString() : null,
      uptimeSeconds: s.bootTime
        ? Math.max(0, Math.floor((Date.now() - s.bootTime.getTime()) / 1000))
        : null,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
      seal: s.seal,
      role,
      canWrite: WRITE_ROLES.includes(role),
    };
  }
}
