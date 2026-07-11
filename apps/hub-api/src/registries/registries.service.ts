import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { registryLoginPrelude, registryLogoutSteps, type RegistryAuth } from "../deploy/deploy-script";
import type { CreateRegistryInput, UpdateRegistryInput } from "./dto";

export interface RegistryView {
  id: string;
  name: string;
  teamId: string;
  type: string;
  url: string | null;
  username: string;
  imagePrefix: string | null;
  createdAt: Date;
  canWrite: boolean;
}

interface RegistryRow {
  id: string;
  name: string;
  teamId: string;
  type: string;
  url: string | null;
  username: string;
  imagePrefix: string | null;
  createdAt: Date;
}

@Injectable()
export class RegistriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
  ) {}

  private view(r: RegistryRow, canWrite: boolean): RegistryView {
    // The encrypted password is NEVER included in the outward view.
    return {
      id: r.id, name: r.name, teamId: r.teamId, type: r.type, url: r.url,
      username: r.username, imagePrefix: r.imagePrefix, createdAt: r.createdAt, canWrite,
    };
  }

  async list(userId: string): Promise<RegistryView[]> {
    const perms = await this.access.permissionsByTeam(userId);
    const teamIds = [...perms.keys()];
    if (!teamIds.length) return [];
    const rows = await this.prisma.registry.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.view(r, perms.get(r.teamId)?.has("integrations") ?? false));
  }

  async create(userId: string, dto: CreateRegistryInput): Promise<RegistryView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    const r = await this.prisma.registry.create({
      data: {
        teamId: dto.teamId,
        name: dto.name,
        type: dto.type,
        url: dto.url ?? null,
        username: dto.username,
        passwordEnc: this.crypto.encrypt(dto.password),
        imagePrefix: dto.imagePrefix ?? null,
      },
    });
    await this.audit.log({ actor: userId, action: "registry.create", target: r.id });
    return this.view(r, true); // only writers reach here (requireRole above)
  }

  async update(userId: string, id: string, dto: UpdateRegistryInput): Promise<RegistryView> {
    const existing = await this.prisma.registry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("registry not found");
    await this.access.requirePermission(userId, existing.teamId, "integrations");
    const r = await this.prisma.registry.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.username !== undefined ? { username: dto.username } : {}),
        ...(dto.imagePrefix !== undefined ? { imagePrefix: dto.imagePrefix } : {}),
        // Only re-encrypt the password when a new one is supplied (write-only field).
        ...(dto.password ? { passwordEnc: this.crypto.encrypt(dto.password) } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "registry.update", target: id });
    return this.view(r, true);
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.prisma.registry.findUnique({ where: { id } });
    if (!r) throw new NotFoundException("registry not found");
    await this.access.requirePermission(userId, r.teamId, "integrations");
    await this.prisma.registry.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "registry.remove", target: id });
  }

  /** Verify the stored credentials by doing a real `docker login` on an online team server
   *  (native auth for every registry type; no hub-side outbound fetch → no SSRF surface). */
  async testLogin(userId: string, id: string): Promise<{ ok: true }> {
    const r = await this.prisma.registry.findUnique({ where: { id } });
    if (!r) throw new NotFoundException("registry not found");
    if (!(await this.access.teamRole(userId, r.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    const servers = await this.prisma.server.findMany({ where: { teamId: r.teamId } });
    const online = servers.find((s) => this.agentWs.isOnline(s.id));
    if (!online) throw new BadRequestException("no online server available to test the registry login");
    const auth: RegistryAuth = { url: r.url ?? undefined, user: r.username, token: this.crypto.decrypt(r.passwordEnc) };
    const script = ["set -e", ...registryLoginPrelude(auth), ...registryLogoutSteps(auth), "echo TUGRA_REGISTRY_OK"].join("\n");
    const res = await this.agentWs.sendCommand(online.id, script, "deploy", 30_000);
    if (res.exitCode !== 0) throw new BadRequestException("registry login failed — check the host, username and password/token");
    await this.audit.log({ actor: userId, action: "registry.test", target: id });
    return { ok: true };
  }
}
