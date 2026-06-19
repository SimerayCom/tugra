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
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoService } from "../crypto/crypto.service";
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
import type { CreateDatabaseInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];
const PROVISION_TIMEOUT_MS = 300_000; // image pull can be slow

export interface DatabaseView {
  id: string;
  name: string;
  engine: DbEngine;
  version: string;
  environmentId: string | null;
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
  backupEnabled: boolean;
  backupIntervalHours: number | null;
  backupRetention: number;
  backupDestinationId: string | null;
  backupSupported: boolean;
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
  ) {}

  async create(userId: string, dto: CreateDatabaseInput): Promise<DatabaseView> {
    const server = await this.prisma.server.findUnique({ where: { id: dto.serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requireRole(userId, server.teamId, WRITE);
    if (dto.environmentId) await this.assertEnvInTeam(dto.environmentId, server.teamId);

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
        environmentId: dto.environmentId ?? null,
        serverId: dto.serverId,
        teamId: server.teamId,
        credentials: this.crypto.encrypt(JSON.stringify(creds)),
        status: DbStatus.NEW,
      },
    });
    await this.audit.log({ actor: userId, action: "database.create", target: db.id });
    const role = (await this.access.teamRole(userId, server.teamId))!;
    return this.view(db, role);
  }

  async list(userId: string): Promise<DatabaseView[]> {
    const roleByTeam = await this.access.roleByTeam(userId);
    const ids = [...roleByTeam.keys()];
    if (!ids.length) return [];
    const dbs = await this.prisma.database.findMany({
      where: { teamId: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
    return dbs.map((d) => this.view(d, roleByTeam.get(d.teamId)!));
  }

  async get(userId: string, id: string): Promise<DatabaseView> {
    const db = await this.require(userId, id);
    const role = (await this.access.teamRole(userId, db.teamId))!;
    return this.view(db, role);
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
    return this.view(updated, role);
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

  async setEnvironment(userId: string, id: string, environmentId: string | null): Promise<void> {
    const db = await this.requireWrite(userId, id);
    if (environmentId) await this.assertEnvInTeam(environmentId, db.teamId);
    await this.prisma.database.update({ where: { id }, data: { environmentId } });
    await this.audit.log({ actor: userId, action: "database.environment.update", target: id });
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
    };
  }

  private async require(userId: string, id: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id } });
    if (!db) throw new NotFoundException("database not found");
    if (!(await this.access.teamRole(userId, db.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    return db;
  }

  private async requireWrite(userId: string, id: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id } });
    if (!db) throw new NotFoundException("database not found");
    await this.access.requireRole(userId, db.teamId, WRITE);
    return db;
  }

  private view(db: Database, role: Role): DatabaseView {
    const canWrite = WRITE.includes(role);
    const conn = canWrite ? connectionInfo(this.toSpec(db)) : null;
    return {
      id: db.id,
      name: db.name,
      engine: db.engine as DbEngine,
      version: db.version,
      environmentId: db.environmentId,
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
      backupEnabled: db.backupEnabled,
      backupIntervalHours: db.backupIntervalHours,
      backupRetention: db.backupRetention,
      backupDestinationId: db.backupDestinationId,
      backupSupported: supportsBackup(db.engine as DbEngine),
      role,
      canWrite,
      createdAt: db.createdAt,
    };
  }
}

function defaultVersion(engine: DbEngine): string {
  return ENGINES[engine].defaultVersion;
}
