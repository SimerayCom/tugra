import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Database, DbStatus, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService, canAccessResource, resolvePermissions } from "../common/team-access.service";
import { loadProjectCtx, loadProjectCtxMany, type ResourceProjectCtx } from "../common/resource-project";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoService } from "../crypto/crypto.service";
import { TeamDefaultsService } from "../teams/team-defaults.service";
import {
  buildDatabaseRunScript,
  buildDbRemoveScript,
  buildDbStopScript,
  connectionInfo,
  enginePort,
  ENGINES,
  resolveImage,
  supportsBackup,
  type DbCredentials,
  type DbEngine,
  type DbSpec,
} from "./database-script";
import { normalizeTags } from "../common/tags";
import type { CreateDatabaseInput, SetDatabaseLimitsInput } from "./dto";

const PROVISION_TIMEOUT_MS = 300_000; // image pull can be slow

export interface DatabaseView {
  id: string;
  name: string;
  engine: DbEngine;
  version: string;
  environmentId: string | null;
  projectId: string | null;
  projectName: string | null;
  environmentName: string | null;
  serverId: string;
  teamId: string;
  status: DbStatus;
  port: number;
  hostPort: number | null;
  // Connection details are decrypted only for members who can write.
  connectionUri: string | null;
  internalHost: string | null;
  username: string | null;
  password: string | null;
  database: string | null;
  healthCmd: string | null;
  memoryMb: number | null;
  cpus: number | null;
  backupEnabled: boolean;
  backupIntervalHours: number | null;
  backupRetention: number;
  backupDestinationId: string | null;
  backupSupported: boolean;
  tags: string[];
  role: Role;
  canWrite: boolean;
  createdAt: Date;
}

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "tugra";
}

@Injectable()
export class DatabasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly crypto: CryptoService,
    private readonly teamDefaults: TeamDefaultsService,
  ) {}

  async create(userId: string, dto: CreateDatabaseInput): Promise<DatabaseView> {
    const server = await this.prisma.server.findUnique({ where: { id: dto.serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "databases");
    if (dto.environmentId) await this.assertEnvInTeam(dto.environmentId, server.teamId);
    // Never orphan: fall back to the team's default environment when none is chosen.
    const environmentId =
      dto.environmentId ?? (await this.teamDefaults.resolveDefaultEnvironmentId(server.teamId));

    const engine = dto.engine as DbEngine;
    const version = dto.version ?? defaultVersion(engine);
    const creds: DbCredentials = {
      username: "tugra",
      password: randomBytes(24).toString("base64url"),
      database: slug(dto.name),
    };
    const db = await this.prisma.database.create({
      data: {
        name: dto.name,
        engine,
        version,
        image: resolveImage(engine, version),
        port: enginePort(engine),
        hostPort: dto.hostPort ?? null,
        environmentId,
        serverId: dto.serverId,
        teamId: server.teamId,
        credentials: this.crypto.encrypt(JSON.stringify(creds)),
        status: DbStatus.NEW,
      },
    });
    // Grant-on-create: the creator keeps access to what they made even if later restricted.
    await this.access.grantResourceAccess(userId, server.teamId, db.id);
    await this.audit.log({ actor: userId, action: "database.create", target: db.id });
    const role = (await this.access.teamRole(userId, server.teamId))!;
    // Creator just passed the 'databases' permission gate above, so they can write.
    return this.view(db, role, true);
  }

  async list(userId: string): Promise<DatabaseView[]> {
    const access = await this.access.accessByTeam(userId);
    const perms = await this.access.permissionsByTeam(userId);
    const ids = [...access.keys()];
    if (!ids.length) return [];
    const dbs = await this.prisma.database.findMany({
      where: { teamId: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
    const ctxByEnv = await loadProjectCtxMany(this.prisma, dbs.map((d) => d.environmentId));
    // Per-resource scoping: a restricted member only sees dbs in projects they're granted.
    return dbs
      .filter((d) => canAccessResource(access.get(d.teamId), d.id, ctxByEnv.get(d.environmentId)?.projectId ?? null))
      .map((d) =>
        this.view(
          d,
          access.get(d.teamId)!.role,
          perms.get(d.teamId)?.has("databases") ?? false,
          ctxByEnv.get(d.environmentId),
        ),
      );
  }

  async get(userId: string, id: string): Promise<DatabaseView> {
    const db = await this.require(userId, id);
    const role = (await this.access.teamRole(userId, db.teamId))!;
    const canWrite = await this.canWriteDatabases(userId, db.teamId);
    const ctx = await loadProjectCtx(this.prisma, db.environmentId);
    return this.view(db, role, canWrite, ctx);
  }

  async provision(userId: string, id: string): Promise<DatabaseView> {
    const db = await this.requireWrite(userId, id);
    let status: DbStatus = DbStatus.FAILED;
    try {
      const r = await this.agentWs.sendCommand(
        db.serverId,
        buildDatabaseRunScript(this.toSpec(db)),
        "database",
        PROVISION_TIMEOUT_MS,
      );
      status = r.exitCode === 0 ? DbStatus.RUNNING : DbStatus.FAILED;
    } catch {
      status = DbStatus.FAILED;
    }
    const updated = await this.prisma.database.update({ where: { id }, data: { status } });
    await this.audit.log({ actor: userId, action: "database.provision", target: id });
    const role = (await this.access.teamRole(userId, db.teamId))!;
    // requireWrite above enforced the 'databases' permission, so the actor can write.
    return this.view(updated, role, true);
  }

  async stop(userId: string, id: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    await this.agentWs.sendCommand(db.serverId, buildDbStopScript(db), "database").catch(() => undefined);
    await this.prisma.database.update({ where: { id }, data: { status: DbStatus.STOPPED } });
    await this.audit.log({ actor: userId, action: "database.stop", target: id });
  }

  async remove(userId: string, id: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    await this.agentWs.sendCommand(db.serverId, buildDbRemoveScript(db), "database").catch(() => undefined);
    await this.prisma.database.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "database.remove", target: id });
  }

  async setEnvironment(userId: string, id: string, environmentId: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    await this.assertEnvInTeam(environmentId, db.teamId);
    await this.prisma.database.update({ where: { id }, data: { environmentId } });
    await this.audit.log({ actor: userId, action: "database.environment.update", target: id });
  }

  async setTags(userId: string, id: string, tags: string[]): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.database.update({
      where: { id },
      data: { tags: normalizeTags(tags) },
    });
    await this.audit.log({ actor: userId, action: "database.tags.update", target: id });
  }

  async setLimits(userId: string, id: string, limits: SetDatabaseLimitsInput): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.database.update({
      where: { id },
      data: {
        healthCmd: limits.healthCmd ?? null,
        memoryMb: limits.memoryMb ?? null,
        cpus: limits.cpus ?? null,
      },
    });
    await this.audit.log({ actor: userId, action: "db.limits.update", target: id });
  }

  async rename(userId: string, id: string, name: string): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.database.update({ where: { id }, data: { name } });
    await this.audit.log({ actor: userId, action: "database.name.update", target: id });
  }

  async setPort(userId: string, id: string, hostPort: number | null): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.database.update({ where: { id }, data: { hostPort } });
    await this.audit.log({ actor: userId, action: "db.port.update", target: id });
  }

  // ── helpers ──
  private async assertEnvInTeam(environmentId: string, teamId: string): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { project: true },
    });
    if (!env || env.project.teamId !== teamId) {
      throw new BadRequestException("environment not found in this team");
    }
  }

  private creds(db: Database): DbCredentials {
    return JSON.parse(this.crypto.decrypt(db.credentials)) as DbCredentials;
  }

  private toSpec(db: Database): DbSpec {
    return {
      id: db.id,
      engine: db.engine as DbEngine,
      image: db.image,
      port: db.port,
      hostPort: db.hostPort,
      credentials: this.creds(db),
      healthCmd: db.healthCmd,
      memoryMb: db.memoryMb,
      cpus: db.cpus,
    };
  }

  private async require(userId: string, id: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id } });
    if (!db) throw new NotFoundException("database not found");
    if (!(await this.access.teamRole(userId, db.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    // Per-resource scoping: a restricted member must be granted this db (or its project).
    await this.access.requireResourceAccess(userId, db.teamId, {
      resourceId: db.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, db.environmentId).then((c) => c.projectId),
    });
    return db;
  }

  private async requireWrite(userId: string, id: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id } });
    if (!db) throw new NotFoundException("database not found");
    await this.access.requirePermission(userId, db.teamId, "databases");
    return db;
  }

  /** Effective 'databases' write permission for a member in one team (single membership read). */
  private async canWriteDatabases(userId: string, teamId: string): Promise<boolean> {
    const m = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true, teamRole: { select: { permissions: true } } },
    });
    return resolvePermissions(m).has("databases");
  }

  private view(db: Database, role: Role, canWrite: boolean, ctx?: ResourceProjectCtx): DatabaseView {
    const conn = canWrite ? connectionInfo(this.toSpec(db)) : null;
    return {
      id: db.id,
      name: db.name,
      engine: db.engine as DbEngine,
      version: db.version,
      environmentId: db.environmentId,
      projectId: ctx?.projectId ?? null,
      projectName: ctx?.projectName ?? null,
      environmentName: ctx?.environmentName ?? null,
      serverId: db.serverId,
      teamId: db.teamId,
      status: db.status,
      port: db.port,
      hostPort: db.hostPort,
      connectionUri: conn?.uri ?? null,
      internalHost: conn?.internalHost ?? null,
      username: conn?.username ?? null,
      password: conn?.password ?? null,
      database: conn?.database ?? null,
      healthCmd: db.healthCmd,
      memoryMb: db.memoryMb,
      cpus: db.cpus,
      backupEnabled: db.backupEnabled,
      backupIntervalHours: db.backupIntervalHours,
      backupRetention: db.backupRetention,
      backupDestinationId: db.backupDestinationId,
      backupSupported: supportsBackup(db.engine as DbEngine),
      tags: db.tags,
      role,
      canWrite,
      createdAt: db.createdAt,
    };
  }
}

function defaultVersion(engine: DbEngine): string {
  return ENGINES[engine].defaultVersion;
}
