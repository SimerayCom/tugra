import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import type { CreateClusterInput, SetServersInput, UpdateClusterInput } from "./dto";

export interface ClusterHealth {
  nodes: { online: number; offline: number; pending: number; total: number };
  apps: { running: number; stopped: number; failed: number; new: number; total: number };
}
export interface ClusterServerView {
  id: string;
  name: string;
  status: string;
  hostname: string | null;
  publicIp: string | null;
}
export interface ClusterView {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  nodeCount: number;
  swarmStatus: string;
  canWrite: boolean;
  createdAt: Date;
}
export interface ClusterDetail extends ClusterView {
  servers: ClusterServerView[];
  health: ClusterHealth;
}

/**
 * Team-scoped server groups ("clusters") — fleet organization + a health rollup + a target for
 * group-scoped bulk ops (the web runs those through the existing /bulk endpoint with the members' ids).
 * This is model-agnostic: it does NOT change deploy/networking (deploy is still per-server). Multi-node
 * deploy (Swarm / replication) is a later phase built on this grouping.
 */
@Injectable()
export class ClustersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string, teamId?: string): Promise<ClusterView[]> {
    const perms = await this.access.permissionsByTeam(userId);
    let teamIds = [...perms.keys()];
    if (teamId) teamIds = teamIds.filter((t) => t === teamId); // filter to the requested team (if a member)
    if (!teamIds.length) return [];
    const rows = await this.prisma.cluster.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { servers: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      name: r.name,
      description: r.description,
      nodeCount: r._count.servers,
      swarmStatus: r.swarmStatus,
      canWrite: perms.get(r.teamId)?.has("servers:manage") ?? false,
      createdAt: r.createdAt,
    }));
  }

  async get(userId: string, id: string): Promise<ClusterDetail> {
    const cluster = await this.prisma.cluster.findUnique({ where: { id } });
    // Non-members get a 404 (don't reveal a cluster exists in another team).
    if (!cluster || !(await this.access.teamIds(userId)).includes(cluster.teamId)) {
      throw new NotFoundException("cluster not found");
    }
    const perms = await this.access.membershipPermissions(userId, cluster.teamId);
    const servers = await this.prisma.server.findMany({
      where: { clusterId: id },
      select: { id: true, name: true, status: true, hostname: true, publicIp: true },
      orderBy: { name: "asc" },
    });
    return {
      id: cluster.id,
      teamId: cluster.teamId,
      name: cluster.name,
      description: cluster.description,
      nodeCount: servers.length,
      swarmStatus: cluster.swarmStatus,
      canWrite: perms?.has("servers:manage") ?? false,
      createdAt: cluster.createdAt,
      servers,
      health: await this.health(servers),
    };
  }

  async create(userId: string, dto: CreateClusterInput): Promise<ClusterView> {
    await this.access.requirePermission(userId, dto.teamId, "servers:manage");
    let row;
    try {
      row = await this.prisma.cluster.create({
        data: { teamId: dto.teamId, name: dto.name, description: dto.description ?? null },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("a cluster with this name already exists");
      }
      throw e;
    }
    await this.audit.log({ actor: userId, action: "cluster.create", target: row.id });
    return { id: row.id, teamId: row.teamId, name: row.name, description: row.description, nodeCount: 0, swarmStatus: row.swarmStatus, canWrite: true, createdAt: row.createdAt };
  }

  async update(userId: string, id: string, dto: UpdateClusterInput): Promise<ClusterDetail> {
    const cluster = await this.requireWrite(userId, id);
    const data: { name?: string; description?: string | null } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description || null;
    try {
      await this.prisma.cluster.update({ where: { id: cluster.id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("a cluster with this name already exists");
      }
      throw e;
    }
    await this.audit.log({ actor: userId, action: "cluster.update", target: id });
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const cluster = await this.requireWrite(userId, id);
    // Don't delete a cluster whose swarm is still formed: SetNull would free the members but keep their
    // swarmRole, stranding a live swarm on boxes Tugra no longer groups (and dropping the only handle —
    // swarmManagerId — to tear it down). Dissolve the swarm first.
    if (cluster.swarmStatus !== "NONE") {
      throw new ConflictException("dissolve the swarm before deleting the cluster");
    }
    // onDelete: SetNull frees the member servers rather than deleting them.
    await this.prisma.cluster.delete({ where: { id: cluster.id } });
    await this.audit.log({ actor: userId, action: "cluster.remove", target: id });
  }

  async setServers(userId: string, id: string, dto: SetServersInput): Promise<ClusterDetail> {
    const cluster = await this.requireWrite(userId, id);
    const ids = [...new Set(dto.serverIds)];
    if (ids.length) {
      // Tenancy guard: every server must belong to THIS cluster's team — you can't pull another team's
      // server into your cluster (which would also expose it to the cluster's group-scoped bulk ops).
      const owned = await this.prisma.server.count({ where: { id: { in: ids }, teamId: cluster.teamId } });
      if (owned !== ids.length) throw new BadRequestException("all servers must belong to this cluster's team");
    }
    // If a Docker Swarm is formed on this cluster, refuse to silently drop a joined node — that would strand
    // a live swarm on a box Tugra no longer tracks. The swarm must be dissolved (or that node left) first.
    if (cluster.swarmStatus !== "NONE") {
      const stranded = await this.prisma.server.findMany({
        where: { clusterId: id, swarmRole: { not: null }, id: { notIn: ids.length ? ids : ["__none__"] } },
        select: { id: true },
      });
      if (stranded.length) {
        throw new ConflictException("dissolve the swarm (or leave these nodes) before changing membership");
      }
    }
    await this.prisma.$transaction([
      // Release servers currently in the cluster that are no longer selected.
      this.prisma.server.updateMany({ where: { clusterId: id, id: { notIn: ids.length ? ids : ["__none__"] } }, data: { clusterId: null } }),
      // Assign the selected servers to the cluster.
      ...(ids.length ? [this.prisma.server.updateMany({ where: { id: { in: ids }, teamId: cluster.teamId }, data: { clusterId: id } })] : []),
    ]);
    await this.audit.log({ actor: userId, action: "cluster.set_servers", target: id, meta: { count: ids.length } });
    return this.get(userId, id);
  }

  /** Load a cluster and require servers:manage on its team; 404 for non-members. */
  private async requireWrite(userId: string, id: string): Promise<{ id: string; teamId: string; swarmStatus: string }> {
    const cluster = await this.prisma.cluster.findUnique({ where: { id }, select: { id: true, teamId: true, swarmStatus: true } });
    if (!cluster || !(await this.access.teamIds(userId)).includes(cluster.teamId)) {
      throw new NotFoundException("cluster not found");
    }
    await this.access.requirePermission(userId, cluster.teamId, "servers:manage");
    return cluster;
  }

  private async health(servers: Array<{ id: string; status: string }>): Promise<ClusterHealth> {
    const nodes = { online: 0, offline: 0, pending: 0, total: servers.length };
    for (const s of servers) {
      if (s.status === "ONLINE") nodes.online++;
      else if (s.status === "OFFLINE") nodes.offline++;
      else nodes.pending++;
    }
    const apps = { running: 0, stopped: 0, failed: 0, new: 0, total: 0 };
    if (servers.length) {
      const rows = await this.prisma.application.findMany({
        where: { serverId: { in: servers.map((s) => s.id) } },
        select: { status: true },
      });
      for (const a of rows) {
        apps.total++;
        if (a.status === "RUNNING") apps.running++;
        else if (a.status === "STOPPED") apps.stopped++;
        else if (a.status === "FAILED") apps.failed++;
        else apps.new++;
      }
    }
    return { nodes, apps };
  }
}
