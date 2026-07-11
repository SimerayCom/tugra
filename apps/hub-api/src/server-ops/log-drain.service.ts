import { Injectable, NotFoundException } from "@nestjs/common";
import { LogDrain } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { CreateLogDrainInput, UpdateLogDrainInput } from "./dto";

export interface LogDrainView {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  enabled: boolean;
  hasToken: boolean;
  createdAt: Date;
}

@Injectable()
export class LogDrainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string, serverId: string): Promise<LogDrainView[]> {
    await this.requireWrite(userId, serverId);
    const rows = await this.prisma.logDrain.findMany({
      where: { serverId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((d) => this.view(d));
  }

  async create(userId: string, serverId: string, dto: CreateLogDrainInput): Promise<LogDrainView> {
    await this.requireWrite(userId, serverId);
    const d = await this.prisma.logDrain.create({
      data: {
        serverId,
        name: dto.name,
        endpoint: dto.endpoint,
        authTokenEnc: dto.token ? this.crypto.encrypt(dto.token) : null,
        enabled: dto.enabled ?? true,
      },
    });
    await this.audit.log({ actor: userId, action: "server.logdrain.create", target: serverId });
    await this.pushToAgent(serverId);
    return this.view(d);
  }

  async update(userId: string, drainId: string, dto: UpdateLogDrainInput): Promise<LogDrainView> {
    const existing = await this.prisma.logDrain.findUnique({ where: { id: drainId } });
    if (!existing) throw new NotFoundException("log drain not found");
    await this.requireWrite(userId, existing.serverId);
    const d = await this.prisma.logDrain.update({
      where: { id: drainId },
      data: {
        name: dto.name ?? undefined,
        endpoint: dto.endpoint ?? undefined,
        enabled: dto.enabled ?? undefined,
        ...(dto.token !== undefined
          ? { authTokenEnc: dto.token ? this.crypto.encrypt(dto.token) : null }
          : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "server.logdrain.update", target: existing.serverId });
    await this.pushToAgent(existing.serverId);
    return this.view(d);
  }

  async remove(userId: string, drainId: string): Promise<void> {
    const existing = await this.prisma.logDrain.findUnique({ where: { id: drainId } });
    if (!existing) throw new NotFoundException("log drain not found");
    await this.requireWrite(userId, existing.serverId);
    await this.prisma.logDrain.delete({ where: { id: drainId } });
    await this.audit.log({ actor: userId, action: "server.logdrain.remove", target: existing.serverId });
    await this.pushToAgent(existing.serverId);
  }

  /** Push the server's enabled drains (with decrypted tokens) to its agent. */
  async pushToAgent(serverId: string): Promise<void> {
    const rows = await this.prisma.logDrain.findMany({ where: { serverId, enabled: true } });
    const drains = rows.map((d) => ({
      id: d.id,
      endpoint: d.endpoint,
      token: d.authTokenEnc ? this.safeDecrypt(d.authTokenEnc) : "",
    }));
    this.agentWs.sendToAgent(serverId, { type: "log_drains", drains });
  }

  private safeDecrypt(enc: string): string {
    try {
      return this.crypto.decrypt(enc);
    } catch {
      return "";
    }
  }

  private view(d: LogDrain): LogDrainView {
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      endpoint: d.endpoint,
      enabled: d.enabled,
      hasToken: !!d.authTokenEnc,
      createdAt: d.createdAt,
    };
  }

  private async requireWrite(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
  }
}
