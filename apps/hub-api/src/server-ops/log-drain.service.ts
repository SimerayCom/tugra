import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { LogDrain, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { LogDrainPushService, type DrainDelivery, type DrainStatusView } from "../log-drains/log-drain-push.service";
import { isNetDrainType, validateContainers, validateDrainShape } from "../log-drains/log-drain-shape";
import type { CreateLogDrainInput, UpdateLogDrainInput } from "./dto";

export interface LogDrainView {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  enabled: boolean;
  hasToken: boolean;
  createdAt: Date;
  // D7 (additive): scope + filter + options + egress flag + delivery state.
  scope: "server" | "app";
  appId: string | null;
  containers: string[];
  options: Record<string, unknown> | null;
  allowPrivate: boolean;
  delivery: DrainDelivery;
  status: DrainStatusView | null;
}

/** One app-scoped drain shipping logs off this server, as shown to the server operator: NO endpoint, options,
 *  containers or token (the operator sees why logs leave the host without seeing an app writer's credentials). */
export interface AppDrainSummary {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  appId: string;
  appName: string;
  delivery: DrainDelivery;
}

@Injectable()
export class LogDrainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly crypto: CryptoService,
    // kept for constructor-signature stability: pushing now lives in LogDrainPushService
    private readonly agentWs: AgentWsServer,
    private readonly audit: AuditService,
    private readonly push: LogDrainPushService,
  ) {}

  async list(userId: string, serverId: string): Promise<LogDrainView[]> {
    await this.requireWrite(userId, serverId);
    const rows = await this.prisma.logDrain.findMany({
      where: { serverId, appId: null },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((d) => this.view(d));
  }

  /** App drains whose effective targets include this server (servers:ops), minus endpoint/options/token. */
  async listApps(userId: string, serverId: string): Promise<AppDrainSummary[]> {
    const server = await this.requireWrite(userId, serverId);
    const rows = await this.prisma.logDrain.findMany({
      where: {
        appId: { not: null },
        OR: [{ app: { serverId, clusterId: null } }, ...(server.clusterId ? [{ app: { clusterId: server.clusterId } }] : [])],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { app: { select: { name: true } } },
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      enabled: d.enabled,
      appId: d.appId as string,
      appName: d.app?.name ?? "",
      delivery: this.push.deliveryFor(d, [serverId]).delivery,
    }));
  }

  async create(userId: string, serverId: string, dto: CreateLogDrainInput): Promise<LogDrainView> {
    await this.requireWrite(userId, serverId);
    const { options } = validateDrainShape({
      type: dto.type,
      endpoint: dto.endpoint,
      options: dto.options,
      scope: "server",
      allowPrivate: false,
      hasToken: !!dto.token,
    });
    const containers = validateContainers("server", dto.containers ?? []);
    const d = await this.prisma.logDrain.create({
      data: {
        serverId,
        name: dto.name,
        type: dto.type,
        endpoint: dto.endpoint,
        authTokenEnc: dto.token ? this.crypto.encrypt(dto.token) : null,
        enabled: dto.enabled ?? true,
        containers,
        ...(options ? { options: options as Prisma.InputJsonValue } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "server.logdrain.create", target: serverId });
    await this.pushToAgent(serverId);
    return this.view(d);
  }

  /** `serverId` (the URL's :id) must own the drain: a mismatch is a 404, as is an app-scoped drain. */
  async update(userId: string, drainId: string, dto: UpdateLogDrainInput, serverId?: string): Promise<LogDrainView> {
    const existing = await this.requireServerDrain(drainId, serverId);
    await this.requireWrite(userId, existing.serverId);

    const data: Prisma.LogDrainUncheckedUpdateInput = {
      name: dto.name ?? undefined,
      type: dto.type ?? undefined,
      endpoint: dto.endpoint ?? undefined,
      enabled: dto.enabled ?? undefined,
      ...(dto.token !== undefined ? { authTokenEnc: dto.token ? this.crypto.encrypt(dto.token) : null } : {}),
    };

    // Only validate what is being written: toggling `enabled` or renaming never re-validates a legacy row.
    const touchesShape = dto.type !== undefined || dto.endpoint !== undefined || dto.options !== undefined;
    const mergedType = dto.type ?? existing.type;
    const hasTokenAfter = dto.token === undefined ? !!existing.authTokenEnc : !!dto.token;
    if (dto.token && (mergedType === "syslog" || mergedType === "gelf")) {
      throw new BadRequestException(`${mergedType} has no authentication: remove the token`);
    }
    if (touchesShape) {
      const typeChanged = dto.type !== undefined && dto.type !== existing.type;
      const crossesNet = typeChanged && (isNetDrainType(dto.type as string) || isNetDrainType(existing.type));
      if (crossesNet) {
        if (dto.endpoint === undefined) throw new BadRequestException("changing the drain type needs the new endpoint in the same request");
        if (isNetDrainType(dto.type as string) && dto.options == null) throw new BadRequestException("changing to this drain type needs its options in the same request");
      }
      const options = dto.options !== undefined ? dto.options : crossesNet ? null : ((existing.options as Record<string, unknown> | null) ?? null);
      const shaped = validateDrainShape({
        type: mergedType,
        endpoint: dto.endpoint ?? existing.endpoint,
        options,
        scope: "server",
        allowPrivate: false,
        hasToken: hasTokenAfter,
      });
      data.options = shaped.options ? (shaped.options as Prisma.InputJsonValue) : Prisma.DbNull;
    }
    if (dto.containers !== undefined) data.containers = validateContainers("server", dto.containers);

    const d = await this.prisma.logDrain.update({ where: { id: drainId }, data });
    await this.audit.log({ actor: userId, action: "server.logdrain.update", target: existing.serverId });
    await this.pushToAgent(existing.serverId);
    return this.view(d);
  }

  async remove(userId: string, drainId: string, serverId?: string): Promise<void> {
    const existing = await this.requireServerDrain(drainId, serverId);
    await this.requireWrite(userId, existing.serverId);
    await this.prisma.logDrain.delete({ where: { id: drainId } });
    await this.audit.log({ actor: userId, action: "server.logdrain.remove", target: existing.serverId });
    await this.pushToAgent(existing.serverId);
  }

  /** Push the server's enabled drains to its agent (delegates to LogDrainPushService; kept for callers). */
  async pushToAgent(serverId: string): Promise<void> {
    await this.push.pushToAgent(serverId);
  }

  /** 404 unless the drain exists, is SERVER-scoped, and (when given) belongs to this server. */
  private async requireServerDrain(drainId: string, serverId?: string): Promise<LogDrain> {
    const existing = await this.prisma.logDrain.findUnique({ where: { id: drainId } });
    if (!existing || existing.appId !== null || (serverId !== undefined && existing.serverId !== serverId)) {
      throw new NotFoundException("log drain not found");
    }
    return existing;
  }

  private view(d: LogDrain): LogDrainView {
    const { delivery, status } = this.push.deliveryFor(d, [d.serverId]);
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      endpoint: d.endpoint,
      enabled: d.enabled,
      hasToken: !!d.authTokenEnc,
      createdAt: d.createdAt,
      scope: "server",
      appId: null,
      containers: d.containers ?? [],
      options: (d.options as Record<string, unknown> | null) ?? null,
      allowPrivate: false,
      delivery,
      status,
    };
  }

  private async requireWrite(userId: string, serverId: string): Promise<{ id: string; teamId: string; clusterId: string | null }> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
    return server;
  }
}
