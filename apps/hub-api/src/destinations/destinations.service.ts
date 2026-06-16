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
import type { CreateDestinationInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];

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
  ) {}

  async create(userId: string, dto: CreateDestinationInput): Promise<DestinationView> {
    await this.access.requireRole(userId, dto.teamId, WRITE);
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
    return this.view(dest, role);
  }

  async list(userId: string): Promise<DestinationView[]> {
    const roleByTeam = await this.access.roleByTeam(userId);
    const ids = [...roleByTeam.keys()];
    if (!ids.length) return [];
    const dests = await this.prisma.backupDestination.findMany({
      where: { teamId: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
    return dests.map((d) => this.view(d, roleByTeam.get(d.teamId)!));
  }

  async get(userId: string, id: string): Promise<DestinationView> {
    const dest = await this.require(userId, id);
    const role = (await this.access.teamRole(userId, dest.teamId))!;
    return this.view(dest, role);
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
    await this.access.requireRole(userId, dest.teamId, WRITE);
    return dest;
  }

  private view(d: BackupDestination, role: Role): DestinationView {
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
      canWrite: WRITE.includes(role),
      createdAt: d.createdAt,
    };
  }
}
