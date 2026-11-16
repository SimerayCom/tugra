import { ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../../../prisma/prisma.service";
import { ServersService } from "../../../../servers/servers.service";
import type { CapabilityPort } from "../data-contract";

const MIGRATE = "migrate";

/**
 * Grants the opt-in `migrate` capability for a run and takes it away again. It goes through `ServersService.setCapabilities`
 * (so the actor needs `servers:manage`, the change is audited and pushed live to the connected agent). A capability the
 * owner had already granted is never recorded as "added" by the run, so it is never revoked by it.
 */
@Injectable()
export class ServerCapabilityPort implements CapabilityPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly servers: ServersService,
  ) {}

  async ensureMigrate(userId: string, serverId: string): Promise<{ ok: true; added: boolean } | { ok: false; reason: "forbidden" | "not-found" }> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { capabilities: true } });
    if (!s) return { ok: false, reason: "not-found" };
    if (s.capabilities.includes(MIGRATE)) return { ok: true, added: false };
    try {
      await this.servers.setCapabilities(userId, serverId, [...s.capabilities, MIGRATE]);
      return { ok: true, added: true };
    } catch (e) {
      if (e instanceof ForbiddenException) return { ok: false, reason: "forbidden" };
      throw e;
    }
  }

  async releaseMigrate(userId: string, serverId: string): Promise<void> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { capabilities: true } });
    if (!s || !s.capabilities.includes(MIGRATE)) return;
    await this.servers.setCapabilities(userId, serverId, s.capabilities.filter((c) => c !== MIGRATE));
  }
}
