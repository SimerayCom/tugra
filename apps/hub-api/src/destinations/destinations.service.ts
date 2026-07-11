import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { BackupDestination, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { buildDestinationTestScript } from "../backups/backup-script";
import type { S3Config } from "../backups/destination";
import type { CreateDestinationInput } from "./dto";

export interface DestinationView {
  id: string;
  name: string;
  type: "LOCAL" | "S3";
  teamId: string;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Endpoint: string | null;
  s3Prefix: string | null;
  encryptionEnabled: boolean;
  // Secrets (accessKey/secretKey/encryptionKey) are never returned.
  hasCredentials: boolean;
  role: Role;
  canWrite: boolean;
  createdAt: Date;
}

@Injectable()
export class DestinationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
  ) {}

  /** Validate an S3 destination's reachability + credentials by running `mc ls` on an online server. */
  async testConnection(userId: string, id: string): Promise<{ ok: boolean; message: string }> {
    const dest = await this.requireWrite(userId, id);
    if (dest.type !== "S3") return { ok: true, message: "Local destination — nothing to test" };
    const server = await this.prisma.server.findFirst({ where: { teamId: dest.teamId, status: "ONLINE" } });
    if (!server) return { ok: false, message: "Need an online server in this team to run the test" };
    try {
      const r = await this.agentWs.sendCommand(server.id, buildDestinationTestScript(this.toS3Config(dest)), "backup", 30_000);
      return r.exitCode === 0
        ? { ok: true, message: "Connection OK" }
        : { ok: false, message: (r.output || "").trim().slice(0, 300) || "Test failed" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Test failed" };
    }
  }

  private toS3Config(d: BackupDestination): S3Config {
    return {
      bucket: d.s3Bucket ?? "",
      region: d.s3Region ?? "",
      endpoint: d.s3Endpoint ?? "",
      accessKey: d.s3AccessKey ? this.crypto.decrypt(d.s3AccessKey) : "",
      secretKey: d.s3SecretKey ? this.crypto.decrypt(d.s3SecretKey) : "",
      prefix: d.s3Prefix ?? "",
    };
  }

  async create(userId: string, dto: CreateDestinationInput): Promise<DestinationView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    const dest = await this.prisma.backupDestination.create({
      data: {
        teamId: dto.teamId,
        name: dto.name,
        type: dto.type,
        s3Bucket: dto.s3Bucket ?? null,
        s3Region: dto.s3Region ?? null,
        s3Endpoint: dto.s3Endpoint ?? null,
        s3AccessKey: dto.s3AccessKey ? this.crypto.encrypt(dto.s3AccessKey) : null,
        s3SecretKey: dto.s3SecretKey ? this.crypto.encrypt(dto.s3SecretKey) : null,
        s3Prefix: dto.s3Prefix ?? null,
        encryptionEnabled: dto.encryptionEnabled ?? false,
        encryptionKey: dto.encryptionEnabled
          ? this.crypto.encrypt(randomBytes(32).toString("base64url"))
          : null,
      },
    });
    await this.audit.log({ actor: userId, action: "destination.create", target: dest.id });
    const role = (await this.access.teamRole(userId, dto.teamId))!;
    // requirePermission("integrations") succeeded above, so the actor can write.
    return this.view(dest, role, true);
  }

  async list(userId: string): Promise<DestinationView[]> {
    const [roleByTeam, permsByTeam] = await Promise.all([
      this.access.roleByTeam(userId),
      this.access.permissionsByTeam(userId),
    ]);
    const ids = [...roleByTeam.keys()];
    if (!ids.length) return [];
    const dests = await this.prisma.backupDestination.findMany({
      where: { teamId: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
    return dests.map((d) =>
      this.view(d, roleByTeam.get(d.teamId)!, permsByTeam.get(d.teamId)?.has("integrations") ?? false),
    );
  }

  async get(userId: string, id: string): Promise<DestinationView> {
    const dest = await this.require(userId, id);
    const [role, permsByTeam] = await Promise.all([
      this.access.teamRole(userId, dest.teamId),
      this.access.permissionsByTeam(userId),
    ]);
    return this.view(dest, role!, permsByTeam.get(dest.teamId)?.has("integrations") ?? false);
  }

  async remove(userId: string, id: string): Promise<void> {
    const dest = await this.requireWrite(userId, id);
    // Detach any databases pointing at this destination (fall back to LOCAL).
    await this.prisma.database.updateMany({
      where: { backupDestinationId: id },
      data: { backupDestinationId: null },
    });
    await this.prisma.backupDestination.delete({ where: { id: dest.id } });
    await this.audit.log({ actor: userId, action: "destination.remove", target: id });
  }

  // ── helpers ──
  private async require(userId: string, id: string): Promise<BackupDestination> {
    const dest = await this.prisma.backupDestination.findUnique({ where: { id } });
    if (!dest) throw new NotFoundException("destination not found");
    if (!(await this.access.teamRole(userId, dest.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    return dest;
  }

  private async requireWrite(userId: string, id: string): Promise<BackupDestination> {
    const dest = await this.prisma.backupDestination.findUnique({ where: { id } });
    if (!dest) throw new NotFoundException("destination not found");
    await this.access.requirePermission(userId, dest.teamId, "integrations");
    return dest;
  }

  private view(d: BackupDestination, role: Role, canWrite: boolean): DestinationView {
    return {
      id: d.id,
      name: d.name,
      type: d.type as "LOCAL" | "S3",
      teamId: d.teamId,
      s3Bucket: d.s3Bucket,
      s3Region: d.s3Region,
      s3Endpoint: d.s3Endpoint,
      s3Prefix: d.s3Prefix,
      encryptionEnabled: d.encryptionEnabled,
      hasCredentials: !!d.s3AccessKey,
      role,
      canWrite,
      createdAt: d.createdAt,
    };
  }
}
