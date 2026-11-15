import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BackupDestination, Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { filterByQuery } from "../common/query-filter";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { buildDestinationTestScript, buildEncryptionCheckScript, scrubRunOutput } from "../backups/backup-script";
import type { S3Config } from "../backups/destination";
import type { CreateDestinationInput, UpdateDestinationInput } from "./dto";

export const DestinationViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["LOCAL", "S3"]),
  teamId: z.string(),
  s3Bucket: z.string().nullable(),
  s3Region: z.string().nullable(),
  s3Endpoint: z.string().nullable(),
  s3Prefix: z.string().nullable(),
  encryptionEnabled: z.boolean(),
  // Secrets (accessKey/secretKey/encryptionKey) are never returned.
  hasCredentials: z.boolean(),
  role: z.nativeEnum(Role),
  canWrite: z.boolean(),
  createdAt: z.date(),
});
export type DestinationView = z.infer<typeof DestinationViewSchema>;

// POST (create) only: the freshly generated data key, in plaintext, exactly once. Never part of view()/GET.
export const CreateDestinationResponseSchema = DestinationViewSchema.extend({ recoveryKey: z.string().nullable() });
export type CreateDestinationResponse = z.infer<typeof CreateDestinationResponseSchema>;

export const DestinationTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  encryption: z.enum(["OK", "FAILED", "SKIPPED"]).optional(),
});
export type DestinationTestResult = z.infer<typeof DestinationTestResultSchema>;

@Injectable()
export class DestinationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
  ) {}

  /** Validate a destination from an online server of its team: S3 reachability + credentials (`mc ls`), and — for an
   *  encrypted destination of either type — a gpg round-trip with the stored key (gpg installed + key works). */
  async testConnection(userId: string, id: string): Promise<DestinationTestResult> {
    const dest = await this.requireWrite(userId, id);
    const encrypted = dest.encryptionEnabled && !!dest.encryptionKey;
    if (dest.type !== "S3" && !encrypted) {
      return { ok: true, message: "Local destination — nothing to test", encryption: "SKIPPED" };
    }
    const server = await this.prisma.server.findFirst({ where: { teamId: dest.teamId, status: "ONLINE" } });
    if (!server) {
      // Keep today's behaviour: S3 needs a server to test; a LOCAL encrypted one has nothing else to report.
      return dest.type === "S3"
        ? { ok: false, message: "Need an online server in this team to run the test", encryption: "SKIPPED" }
        : { ok: true, message: "Local destination — nothing to test", encryption: "SKIPPED" };
    }
    let message = "Local destination — encryption check passed";
    if (dest.type === "S3") {
      try {
        const r = await this.agentWs.sendCommand(server.id, buildDestinationTestScript(this.toS3Config(dest)), "backup", 30_000);
        if (r.exitCode !== 0) {
          return { ok: false, message: (r.output || "").trim().slice(0, 300) || "Test failed", encryption: "SKIPPED" };
        }
        message = "Connection OK";
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Test failed", encryption: "SKIPPED" };
      }
    }
    if (!encrypted) return { ok: true, message, encryption: "SKIPPED" };
    const key = this.crypto.decrypt(dest.encryptionKey!);
    try {
      const r = await this.agentWs.sendCommand(server.id, buildEncryptionCheckScript(key), "backup", 30_000);
      if (r.exitCode === 0 && r.output.includes("TUGRA_ENC_OK")) return { ok: true, message, encryption: "OK" };
      const msg = r.exitCode === 5 || r.output.includes("TUGRA_GPG_MISSING")
        ? "gpg is not installed on the host"
        : scrubRunOutput((r.output || "").trim(), [key]).slice(0, 300) || "encryption check failed";
      return { ok: false, message: msg, encryption: "FAILED" };
    } catch (e) {
      return { ok: false, message: scrubRunOutput(e instanceof Error ? e.message : "encryption check failed", [key]), encryption: "FAILED" };
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

  /** Create a destination. Encryption is ON by default (new destinations only): a random 256-bit data key is
   *  generated, stored encrypted with the control-plane secrets key, and the PLAINTEXT is returned once as
   *  `recoveryKey` (never again, never logged). Send encryptionEnabled:false to opt out. */
  async create(userId: string, dto: CreateDestinationInput): Promise<CreateDestinationResponse> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    const encrypt = dto.encryptionEnabled ?? true;
    const key = encrypt ? randomBytes(32).toString("base64url") : null;
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
        encryptionEnabled: encrypt,
        encryptionKey: key ? this.crypto.encrypt(key) : null,
      },
    });
    await this.audit.log({ actor: userId, action: "destination.create", target: dest.id, meta: { encrypted: encrypt } });
    const role = (await this.access.teamRole(userId, dto.teamId))!;
    // requirePermission("integrations") succeeded above, so the actor can write.
    return { ...this.view(dest, role, true), recoveryKey: key };
  }

  /** Edit a destination in place — notably to ROTATE S3 keys without recreating it (which would detach every
   *  database schedule pointing at it). Limited to name / region / credentials: the bucket, endpoint, prefix
   *  and encryption flag are intentionally NOT editable, because restore + retention-prune read the CURRENT
   *  bucket/prefix/encryptionKey, so changing them would orphan or un-decrypt every existing backup. A blank/
   *  omitted accessKey/secretKey KEEPS the stored one (rotate only what you re-type). type/teamId are fixed. */
  async update(userId: string, id: string, dto: UpdateDestinationInput): Promise<DestinationView> {
    await this.requireWrite(userId, id);
    const data: Prisma.BackupDestinationUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.s3Region !== undefined) data.s3Region = dto.s3Region;
    // Secrets: only re-encrypt when a new value is sent; omitting them keeps the stored credential. Rotating
    // keys for the SAME bucket is safe — the objects and their location/encryption are unchanged.
    if (dto.s3AccessKey) data.s3AccessKey = this.crypto.encrypt(dto.s3AccessKey);
    if (dto.s3SecretKey) data.s3SecretKey = this.crypto.encrypt(dto.s3SecretKey);
    const updated = await this.prisma.backupDestination.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "destination.update", target: id });
    const role = (await this.access.teamRole(userId, updated.teamId))!;
    return this.view(updated, role, true);
  }

  async list(userId: string, q?: string): Promise<DestinationView[]> {
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
    const views = dests.map((d) =>
      this.view(d, roleByTeam.get(d.teamId)!, permsByTeam.get(d.teamId)?.has("integrations") ?? false),
    );
    return filterByQuery(views, q, (d) => [d.name, d.type, d.s3Bucket, d.s3Region, d.s3Endpoint, d.s3Prefix]);
  }

  async get(userId: string, id: string): Promise<DestinationView> {
    const dest = await this.require(userId, id);
    const [role, permsByTeam] = await Promise.all([
      this.access.teamRole(userId, dest.teamId),
      this.access.permissionsByTeam(userId),
    ]);
    return this.view(dest, role!, permsByTeam.get(dest.teamId)?.has("integrations") ?? false);
  }

  async remove(userId: string, id: string, opts: { discardBackups?: boolean } = {}): Promise<void> {
    const dest = await this.requireWrite(userId, id);
    // A PITR-enabled database pins its destination (its WAL chain + base backups live there); silently falling it
    // back to LOCAL would split the chain. Refuse until PITR is disabled on those databases.
    const pinned = await this.prisma.database.count({ where: { backupDestinationId: id, pitrEnabled: true } });
    if (pinned > 0) {
      throw new ConflictException(`${pinned} database(s) have PITR enabled on this destination; disable PITR on them first`);
    }
    // Deleting an encrypted destination destroys the key its backups need. Refuse unless explicitly confirmed.
    // (HubBackup rows are excluded: they use the .env-derived passphrase, not this destination's key.)
    let discarded = 0;
    if (dest.encryptionEnabled) {
      // Everything but FAILED: a RUNNING/PENDING run is mid-write under this key, so it counts too.
      const where = { destinationId: id, status: { not: "FAILED" as const } };
      const [a, b, c] = await Promise.all([
        this.prisma.backup.count({ where }),
        this.prisma.volumeBackup.count({ where }),
        this.prisma.baseBackup.count({ where }),
      ]);
      discarded = a + b + c;
      if (discarded > 0 && !opts.discardBackups) {
        throw new ConflictException(
          `${discarded} backup(s) were encrypted with this destination's key; deleting it destroys the key. Pass ?discardBackups=true to confirm.`,
        );
      }
    }
    // Detach every pointer at this destination (falls back to LOCAL / unset), then delete, atomically.
    await this.prisma.$transaction([
      this.prisma.database.updateMany({ where: { backupDestinationId: id }, data: { backupDestinationId: null } }),
      this.prisma.application.updateMany({ where: { volumeBackupDestinationId: id }, data: { volumeBackupDestinationId: null } }),
      this.prisma.hubBackupConfig.updateMany({ where: { destinationId: id }, data: { destinationId: null } }),
      this.prisma.backupDestination.delete({ where: { id: dest.id } }),
    ]);
    await this.audit.log({ actor: userId, action: "destination.remove", target: id, meta: { discarded } });
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
