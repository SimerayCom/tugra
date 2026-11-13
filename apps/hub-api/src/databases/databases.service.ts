import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Observable } from "rxjs";
import { z } from "zod";
import { Database, DbStatus, Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, type AuditFilters } from "../audit/audit.service";
import { TeamAccessService, canAccessResource, resolvePermissions } from "../common/team-access.service";
import { loadProjectCtx, loadProjectCtxMany, type ResourceProjectCtx } from "../common/resource-project";
import { filterByQuery } from "../common/query-filter";
import { validatePngIcon } from "../common/png-icon";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { LogStreamService, type LogStreamEvent } from "../agent-gateway/log-stream.service";
import { ContainerMetricsService, type AppContainerMetrics } from "../metrics/container-metrics.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamDefaultsService } from "../teams/team-defaults.service";
import {
  buildDatabaseRunScript,
  buildDbRemoveScript,
  buildDbStopScript,
  connectionInfo,
  reservedDbEnvKeys,
  publicConnectionUri,
  dbContainerName,
  enginePort,
  ENGINES,
  resolveImage,
  supportsBackup,
  type DbCredentials,
  type DbEngine,
  type DbSpec,
  type DbVolume,
} from "./database-script";
import { normalizeSince, normalizeSearch, clampTail } from "../common/log-filters";
import { normalizeTags } from "../common/tags";
import type { CreateDatabaseInput, SetDatabaseLimitsInput } from "./dto";

const PROVISION_TIMEOUT_MS = 300_000; // image pull can be slow

export const DatabaseViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.enum(["POSTGRES", "MYSQL", "REDIS", "MONGO", "MARIADB", "KEYDB", "DRAGONFLY", "CLICKHOUSE", "LIBSQL"]),
  version: z.string(),
  environmentId: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  environmentName: z.string().nullable(),
  serverId: z.string(),
  teamId: z.string(),
  status: z.nativeEnum(DbStatus),
  port: z.number(),
  hostPort: z.number().nullable(),
  // Connection details are decrypted only for members who can write.
  connectionUri: z.string().nullable(),
  internalHost: z.string().nullable(),
  // Reach-from-outside details: set only when a public host port is mapped AND the server's public
  // address is known. publicUri embeds the password, so it is gated like connectionUri (canWrite).
  publicHost: z.string().nullable(),
  publicUri: z.string().nullable(),
  username: z.string().nullable(),
  password: z.string().nullable(),
  database: z.string().nullable(),
  healthCmd: z.string().nullable(),
  memoryMb: z.number().nullable(),
  cpus: z.number().nullable(),
  backupEnabled: z.boolean(),
  backupIntervalHours: z.number().nullable(),
  backupCron: z.string().nullable(),
  backupRetention: z.number(),
  backupRetentionDays: z.number().nullable(),
  backupDestinationId: z.string().nullable(),
  backupSupported: z.boolean(),
  verifyEnabled: z.boolean(),
  verifyIntervalHours: z.number().nullable(),
  verifyCron: z.string().nullable(),
  lastVerifiedAt: z.date().nullable(),
  // PITR (Postgres only): whether WAL archiving is on, and when it was switched on.
  pitrEnabled: z.boolean(),
  pitrEnabledAt: z.date().nullable(),
  tags: z.array(z.string()),
  volumes: z.array(z.object({ name: z.string(), path: z.string() })),
  role: z.nativeEnum(Role),
  canWrite: z.boolean(),
  iconUpdatedAt: z.date().nullable(), // set when a custom icon was uploaded (list-view cache-bust marker)
  createdAt: z.date(),
});
export type DatabaseView = z.infer<typeof DatabaseViewSchema>;

// A clone returns the new database as a flat view (so RedactSecretsInterceptor, which only nulls top-level
// fields, masks its credentials for scope-limited PATs) plus the non-fatal warnings the UI surfaces.
export const CloneDatabaseResponseSchema = DatabaseViewSchema.extend({
  warnings: z.array(z.string()),
});

// "<name> (copy)", keeping the suffix even for a long source name (clamped to the 60-char name cap).
function copyName(name: string): string {
  const suffix = " (copy)";
  const room = 60 - suffix.length;
  return (name.length > room ? name.slice(0, room) : name) + suffix;
}

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "tugra";
}

// A shell-SAFE OCI image reference: optional registry host[:port] / repo path / optional :tag / optional
// @sha256 digest. The character set excludes every shell metacharacter, so a caller-supplied image cannot
// inject into the `docker` command even if a script builder forgets to quote it. (createForImport also gates
// a custom image behind apps:config — running one is an app-image-level privilege.)
const DB_IMAGE_RE =
  /^([a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?\/)?[a-z0-9][a-z0-9._/-]{0,200}(:[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
function assertValidDbImage(image: string): string {
  if (image.length > 255 || !DB_IMAGE_RE.test(image)) throw new BadRequestException("invalid database image reference");
  return image;
}

// A safe SQL/identifier for a caller-supplied DB name or username. public create() derives these from slug()
// (always safe); the importer may pass them, so re-assert the invariant the engine scripts rely on (e.g. the
// ClickHouse backup/restore splices the database name into a query). A valid DB version tag is similar.
const DB_IDENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const DB_VERSION_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

@Injectable()
export class DatabasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly logStream: LogStreamService,
    private readonly containerMetricsSvc: ContainerMetricsService,
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
    const view = await this.persistDatabase(userId, server, {
      name: dto.name,
      engine,
      version,
      image: resolveImage(engine, version),
      hostPort: dto.hostPort ?? null,
      environmentId,
      creds,
    });
    await this.audit.log({ actor: userId, action: "database.create", target: view.id });
    return view;
  }

  /**
   * Internal: create a DB record with CALLER-SUPPLIED credentials and optionally a custom image, for the
   * migrator/importer so a moved app's existing DATABASE_URL keeps working. NOT exposed on the public DTO
   * (the public create() always mints fresh credentials); the image is validated to a shell-safe OCI ref.
   */
  async createForImport(
    userId: string,
    input: {
      name: string;
      serverId: string;
      engine: DbEngine;
      version?: string;
      image?: string;
      username: string;
      password: string;
      database: string;
      hostPort?: number;
      environmentId?: string;
    },
  ): Promise<DatabaseView> {
    const server = await this.prisma.server.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "databases");
    // A custom image runs arbitrary code on the host (like an IMAGE-source app), so require the same
    // app-image privilege rather than letting plain `databases` permission reach it.
    if (input.image) await this.access.requirePermission(userId, server.teamId, "apps:config");
    // Re-assert the identifier invariants that public create()'s slug() guarantees — some engine scripts
    // (ClickHouse) splice the database name into a query, so an arbitrary name would be an injection vector.
    if (!DB_IDENT_RE.test(input.username)) throw new BadRequestException("invalid database username");
    if (!DB_IDENT_RE.test(input.database)) throw new BadRequestException("invalid database name");
    if (!input.password || input.password.length > 256) throw new BadRequestException("invalid database password");
    if (input.environmentId) await this.assertEnvInTeam(input.environmentId, server.teamId);
    const environmentId =
      input.environmentId ?? (await this.teamDefaults.resolveDefaultEnvironmentId(server.teamId));
    const version = input.version ?? defaultVersion(input.engine);
    if (!DB_VERSION_RE.test(version)) throw new BadRequestException("invalid database version");
    const image = input.image ? assertValidDbImage(input.image) : resolveImage(input.engine, version);
    const creds: DbCredentials = {
      username: input.username,
      password: input.password,
      database: input.database,
    };
    const view = await this.persistDatabase(userId, server, {
      name: input.name,
      engine: input.engine,
      version,
      image,
      hostPort: input.hostPort ?? null,
      environmentId,
      creds,
    });
    await this.audit.log({
      actor: userId,
      action: "database.import_create",
      target: view.id,
      meta: { engine: input.engine, customImage: Boolean(input.image) },
    });
    return view;
  }

  /** Create the DB record ONLY (no grant, no view) — the shared core for the user path and the ungated
   *  system throwaway path. Callers that act for a user must additionally grant + audit. */
  private async persistDatabaseRow(
    server: { id: string; teamId: string },
    fields: {
      name: string;
      engine: DbEngine;
      version: string;
      image: string;
      hostPort: number | null;
      environmentId: string;
      creds: DbCredentials;
    },
  ): Promise<Database> {
    return this.prisma.database.create({
      data: {
        name: fields.name,
        engine: fields.engine,
        version: fields.version,
        image: fields.image,
        port: enginePort(fields.engine),
        hostPort: fields.hostPort,
        environmentId: fields.environmentId,
        serverId: server.id,
        teamId: server.teamId,
        credentials: this.crypto.encrypt(JSON.stringify(fields.creds)),
        status: DbStatus.NEW,
      },
    });
  }

  /** Shared DB-record creation for a USER: persist + grant-on-create + return the writer view. Callers audit. */
  private async persistDatabase(
    userId: string,
    server: { id: string; teamId: string },
    fields: {
      name: string;
      engine: DbEngine;
      version: string;
      image: string;
      hostPort: number | null;
      environmentId: string;
      creds: DbCredentials;
    },
  ): Promise<DatabaseView> {
    const db = await this.persistDatabaseRow(server, fields);
    // Grant-on-create: the creator keeps access to what they made even if later restricted.
    await this.access.grantResourceAccess(userId, server.teamId, db.id);
    const role = (await this.access.teamRole(userId, server.teamId))!;
    // Creator just passed the 'databases' permission gate, so they can write.
    return this.view(db, role, true);
  }

  /**
   * Run `fn` against a freshly provisioned, DISPOSABLE database, then ALWAYS reap it (even if `fn` or the
   * provisioning throws). The throwaway is created/provisioned/removed WITHOUT a user and WITHOUT any RBAC
   * check — this is the single ungated seam, for in-process SYSTEM flows (the restore-verify drill). Keep it
   * that way:
   *  - callers must be in-process + trusted — NEVER wire this to a controller;
   *  - the user-facing privilege checks ('databases'/'apps:config') live in the CALLER (e.g.
   *    BackupsService.verifyBackupNow), not here;
   *  - DatabasesService must stay free of any backups-side dependency, or scheduler→runner→databases would
   *    close a DI cycle (BackupRunnerService injects this service).
   * The same identifier/version/image invariants createForImport enforces are re-asserted, because the engine
   * scripts splice these values. Throws 503 WITHOUT running `fn` if the throwaway never reaches RUNNING, so
   * `fn` never sees a dead container.
   */
  async withSystemThrowaway<T>(
    input: {
      name: string;
      serverId: string;
      engine: DbEngine;
      version?: string;
      image?: string;
      username: string;
      password: string;
      database: string;
      environmentId?: string;
    },
    actor: string,
    fn: (ephDb: Database) => Promise<T>,
  ): Promise<T> {
    const server = await this.prisma.server.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException("server not found");
    if (!DB_IDENT_RE.test(input.username)) throw new BadRequestException("invalid database username");
    if (!DB_IDENT_RE.test(input.database)) throw new BadRequestException("invalid database name");
    if (!input.password || input.password.length > 256) throw new BadRequestException("invalid database password");
    const version = input.version ?? defaultVersion(input.engine);
    if (!DB_VERSION_RE.test(version)) throw new BadRequestException("invalid database version");
    const image = input.image ? assertValidDbImage(input.image) : resolveImage(input.engine, version);
    const environmentId =
      input.environmentId ?? (await this.teamDefaults.resolveDefaultEnvironmentId(server.teamId));
    const db = await this.persistDatabaseRow(server, {
      name: input.name,
      engine: input.engine,
      version,
      image,
      hostPort: null, // internal reach only (tugra-net) — a throwaway must never grab a host port
      environmentId,
      creds: { username: input.username, password: input.password, database: input.database },
    });
    try {
      const provisioned = await this.provisionRow(db, actor);
      if (provisioned.status !== DbStatus.RUNNING) {
        throw new ServiceUnavailableException("could not provision the verification target — try again");
      }
      // Re-fetch the row so the caller gets decryptable credentials (the create returned the row as-is).
      const live = await this.prisma.database.findUnique({ where: { id: db.id } });
      if (!live) throw new ServiceUnavailableException("verification target vanished");
      return await fn(live);
    } finally {
      // Always reap (no app links a throwaway, so removeRow proceeds even if the agent teardown fails).
      await this.removeRow(db, { keepVolume: false }, actor).catch(() => undefined);
    }
  }

  async list(userId: string, q?: string): Promise<DatabaseView[]> {
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
    const views = dbs
      .filter((d) => canAccessResource(access.get(d.teamId), d.id, ctxByEnv.get(d.environmentId)?.projectId ?? null))
      .map((d) =>
        this.view(
          d,
          access.get(d.teamId)!.role,
          perms.get(d.teamId)?.has("databases") ?? false,
          ctxByEnv.get(d.environmentId),
        ),
      );
    // `?q`: in-memory substring filter over NON-SECRET fields only (never connectionUri/username/password).
    return filterByQuery(views, q, (d) => [d.name, d.engine, d.version]);
  }

  async get(userId: string, id: string): Promise<DatabaseView> {
    const db = await this.require(userId, id);
    const role = (await this.access.teamRole(userId, db.teamId))!;
    const canWrite = await this.canWriteDatabases(userId, db.teamId);
    const ctx = await loadProjectCtx(this.prisma, db.environmentId);
    // Only the detail page surfaces connection details, so this is the one place we resolve the
    // server's public address (for the reach-from-outside URI when a host port is mapped).
    const server = db.hostPort
      ? await this.prisma.server.findUnique({ where: { id: db.serverId }, select: { publicIp: true, publicIpv6: true } })
      : null;
    const serverPublicHost = server?.publicIp || server?.publicIpv6 || null;
    return this.view(db, role, canWrite, ctx, serverPublicHost);
  }

  /** This database's audit history (every actor). Reuses require()'s membership + per-resource access check. */
  async listAudit(userId: string, id: string, filters?: AuditFilters) {
    await this.require(userId, id);
    return this.audit.listForTarget(id, filters);
  }

  async provision(userId: string, id: string): Promise<DatabaseView> {
    const db = await this.requireWrite(userId, id);
    const updated = await this.provisionRow(db, userId);
    const role = (await this.access.teamRole(userId, db.teamId))!;
    // requireWrite above enforced the 'databases' permission, so the actor can write.
    return this.view(updated, role, true);
  }

  /** Provisioning core (no RBAC): claim PROVISIONING, run the container, persist the outcome, audit.
   *  Returns the updated row (status RUNNING/FAILED). Shared by {@link provision} and {@link withSystemThrowaway}. */
  private async provisionRow(db: Database, actor: string): Promise<Database> {
    // Claim the row as PROVISIONING before the slow (≤5 min) agent call: while it runs we are creating the
    // container + data volume on db.serverId, so a concurrent moveToServer (NEW-only) must be excluded —
    // otherwise the row's serverId could change under us and strand the volume on the old server.
    await this.prisma.database.update({ where: { id: db.id }, data: { status: DbStatus.PROVISIONING } });
    let status: DbStatus = DbStatus.FAILED;
    try {
      const r = await this.agentWs.sendCommand(
        db.serverId,
        // pitr rides the row's own flag. Throwaway verify DBs are persisted with pitrEnabled=false (never set),
        // so this is false for them → their run script stays byte-identical. Only an explicitly-enabled real DB
        // provisions with WAL archiving on.
        buildDatabaseRunScript({ ...this.toSpec(db), env: this.dbEnv(db), volumes: this.dbVolumes(db), pitr: db.pitrEnabled }),
        "database",
        PROVISION_TIMEOUT_MS,
      );
      status = r.exitCode === 0 ? DbStatus.RUNNING : DbStatus.FAILED;
    } catch {
      status = DbStatus.FAILED;
    }
    const updated = await this.prisma.database.update({ where: { id: db.id }, data: { status } });
    await this.audit.log({ actor, action: "database.provision", target: db.id });
    return updated;
  }

  async stop(userId: string, id: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    await this.agentWs.sendCommand(db.serverId, buildDbStopScript(db), "database").catch(() => undefined);
    await this.prisma.database.update({ where: { id }, data: { status: DbStatus.STOPPED } });
    await this.audit.log({ actor: userId, action: "database.stop", target: id });
  }

  async remove(userId: string, id: string, opts: { keepVolume?: boolean } = {}): Promise<void> {
    const db = await this.requireWrite(userId, id);
    await this.removeRow(db, opts, userId);
  }

  /** Removal core (no RBAC): refuse while apps link it, tear the container/volumes down, delete the row, audit.
   *  Shared by {@link remove} and {@link withSystemThrowaway}'s reap. */
  private async removeRow(db: Database, opts: { keepVolume?: boolean }, actor: string): Promise<void> {
    // Refuse while apps still link this database — deleting it would break their injected connection
    // URIs. Name the apps so the user knows what to unlink first (the DB-level FK is NO ACTION as a
    // backstop, but this gives a friendly 409 instead of a raw constraint error).
    const links = await this.prisma.appDatabaseLink.findMany({ where: { databaseId: db.id }, include: { app: { select: { name: true } } } });
    if (links.length > 0) {
      const names = links.map((l) => l.app?.name ?? l.appId);
      throw new ConflictException(`unlink this database from ${names.join(", ")} before deleting it`);
    }
    await this.agentWs.sendCommand(db.serverId, buildDbRemoveScript({ id: db.id, volumes: this.dbVolumes(db) }, opts), "database").catch(() => undefined);
    await this.prisma.database.delete({ where: { id: db.id } });
    await this.audit.log({ actor, action: "database.remove", target: db.id, meta: { keepVolume: !!opts.keepVolume } });
  }

  /**
   * Live `docker logs --follow` stream for this database's container, over the signed "logs"
   * capability. Writer-only (logs can carry credentials, like appLogs). The target is derived
   * server-side (`tugra_db_<id>`) and never taken from the client, so there is nothing to validate
   * or inject. tail/since/search are normalized — they become SIGNED canonicalLogStart fields and
   * reach the shell-less docker/grep argv on the agent, so a malformed value must fold to a safe one.
   */
  async streamLogs(
    userId: string,
    id: string,
    opts: { tail?: number; follow?: boolean; since?: string; search?: string },
  ): Promise<Observable<LogStreamEvent>> {
    const db = await this.requireWrite(userId, id);
    if (!this.agentWs.isOnline(db.serverId)) throw new ServiceUnavailableException("agent offline");
    await this.audit.log({ actor: userId, action: "database.logs.stream", target: id });
    return this.logStream.stream(db.serverId, dbContainerName(db), {
      tail: clampTail(opts.tail),
      follow: opts.follow ?? true,
      since: normalizeSince(opts.since),
      search: normalizeSearch(opts.search),
    });
  }

  /**
   * Pre-flight access check for the log SSE endpoint, run from a guard so the HTTP status is real.
   * `@Sse` commits a 200 + text/event-stream as soon as the handler runs, so a throw from inside can
   * no longer set 403/503 — the guard runs first (canActivate) and its exception becomes the status.
   */
  async assertLogStreamAccess(userId: string, id: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    if (!this.agentWs.isOnline(db.serverId)) throw new ServiceUnavailableException("agent offline");
  }

  /**
   * One-shot log export for download (writer-only). Not a stream — collects `docker logs` in a single
   * request so the browser can save it. The target is server-derived (no injection surface); `since`
   * is normalized and `tail` is clamped before reaching the fixed docker argv.
   */
  async downloadLogs(
    userId: string,
    id: string,
    opts: { tail?: number; since?: string },
  ): Promise<string> {
    const db = await this.requireWrite(userId, id);
    if (!this.agentWs.isOnline(db.serverId)) throw new ServiceUnavailableException("agent offline");
    const tail = clampTail(opts.tail, 10000);
    const since = normalizeSince(opts.since);
    const cmd = `docker logs --timestamps --tail ${tail}${since ? ` --since ${since}` : ""} ${dbContainerName(db)} 2>&1`;
    const r = await this.agentWs.sendCommand(db.serverId, cmd, "database", 60_000);
    await this.audit.log({ actor: userId, action: "database.logs.download", target: id });
    return r.output.slice(0, 5_000_000); // hard cap the response size
  }

  /**
   * Per-container CPU/RAM/network/disk history for this database's Metrics tab. Read-level (metrics
   * carry no secrets, like the app metrics tab). The agent already samples every container on the
   * host, so the `tugra_db_<id>` rows exist; we just query them by the deterministic name prefix.
   */
  async containerMetrics(userId: string, id: string, range?: string): Promise<AppContainerMetrics> {
    const db = await this.require(userId, id);
    return this.containerMetricsSvc.forApp(db.serverId, dbContainerName(db), range);
  }

  async setEnvironment(userId: string, id: string, environmentId: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    await this.assertEnvInTeam(environmentId, db.teamId);
    await this.prisma.database.update({ where: { id }, data: { environmentId } });
    await this.audit.log({ actor: userId, action: "database.environment.update", target: id });
  }

  /**
   * Move a database to another server in the same team. SAFE ONLY BEFORE FIRST DEPLOY: a NEW database has no
   * data volume yet, so the move is pure config. A provisioned (or failed) database's data lives in a docker
   * volume on its current server, and Tugra does not transfer volume data across servers — so moving it would
   * silently leave the data behind. For that case the caller must back it up and restore to a NEW database on
   * the target server. The host port is reset (a port taken on the old server may be taken on the new one).
   */
  async moveToServer(userId: string, id: string, serverId: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    if (serverId === db.serverId) return;
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    if (server.teamId !== db.teamId) throw new ForbiddenException("target server is in another team");
    if (db.status !== DbStatus.NEW) {
      throw new BadRequestException(
        "only a database that hasn't been deployed yet can be moved between servers — back this one up and restore it to a new database on the target server",
      );
    }
    // Atomic re-check: the move only lands while the row is STILL NEW on its original server. A provision
    // that started after our read has flipped it to PROVISIONING, so count === 0 and we refuse — closing the
    // race where a move mid-deploy would point the row at a new server while its volume is built on the old.
    const { count } = await this.prisma.database.updateMany({
      where: { id, status: DbStatus.NEW, serverId: db.serverId },
      data: { serverId, hostPort: null },
    });
    if (count === 0) {
      throw new BadRequestException("the database started deploying while being moved — refresh and try again");
    }
    await this.audit.log({ actor: userId, action: "database.server.update", target: id, meta: { to: serverId } });
  }

  /**
   * Clone a database's CONFIG into a new, un-provisioned database on the SAME server — never its DATA
   * (mirrors Coolify's "clone config, not data" and Tugra's app clone). The clone mints FRESH credentials
   * and an empty data volume (its own id), resets the host port (a copy would clash on the same server), and
   * starts with backups OFF (a copied schedule would have no registered job). engine/version/image/limits/
   * healthcheck/tags are carried. A cross-server clone and a data copy are separate, later slices.
   */
  async clone(userId: string, id: string, opts: { name?: string; environmentId?: string }): Promise<DatabaseView & { warnings: string[] }> {
    const src = await this.requireWrite(userId, id);
    let environmentId = src.environmentId;
    if (opts.environmentId && opts.environmentId !== src.environmentId) {
      await this.assertEnvInTeam(opts.environmentId, src.teamId);
      environmentId = opts.environmentId;
    }
    const name = (opts.name?.trim() || copyName(src.name)).slice(0, 60);
    const creds: DbCredentials = { username: "tugra", password: randomBytes(24).toString("base64url"), database: slug(name) };
    const clone = await this.prisma.database.create({
      data: {
        name,
        engine: src.engine,
        version: src.version,
        image: src.image,
        port: src.port,
        hostPort: null, // a copied host port would clash on the same server
        environmentId,
        serverId: src.serverId,
        teamId: src.teamId,
        credentials: this.crypto.encrypt(JSON.stringify(creds)),
        status: DbStatus.NEW,
        healthCmd: src.healthCmd,
        memoryMb: src.memoryMb,
        cpus: src.cpus,
        tags: src.tags,
        envEnc: src.envEnc, // user env is config → carried to the clone
        // volume DEFINITIONS carry, but the docker volume name derives from the new id → fresh empty
        // volumes, no data shared (structural copy, same as app clone).
        ...(src.volumes ? { volumes: src.volumes as Prisma.InputJsonValue } : {}),
        // backups intentionally NOT copied: an enabled schedule here would have no registered job.
      },
    });
    await this.access.grantResourceAccess(userId, src.teamId, clone.id);
    await this.audit.log({ actor: userId, action: "database.clone", target: clone.id, meta: { from: id } });
    const warnings = ["data_not_copied", ...(src.hostPort ? ["host_port_reset"] : [])];
    const role = (await this.access.teamRole(userId, src.teamId))!;
    // Flat (view + warnings), not { database, warnings }: the secret-redaction interceptor only nulls
    // top-level fields, so nesting the view would leak the clone's credentials to a scope-limited PAT.
    return { ...this.view(clone, role, true), warnings };
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

  /**
   * The node-local (tugra-net) connection URI for this database — host is the container name, so it only
   * resolves for apps attached to tugra-net on the SAME server. Used to auto-inject into a linked app's
   * env at deploy time. The URI embeds the (decrypted) password, so callers must treat it as a secret.
   */
  internalConnectionUri(db: Database): string {
    return connectionInfo(this.toSpec(db)).uri;
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
      // env is decrypted lazily at the provision call site only — view()/internalConnectionUri() never need
      // it, and keeping it out of the default spec narrows a corrupt-blob failure to the deploy path.
    };
  }

  /** Decrypt a database's user-set env vars ({} when none). */
  private dbEnv(db: Database): Record<string, string> {
    if (!db.envEnc) return {};
    return JSON.parse(this.crypto.decrypt(db.envEnc)) as Record<string, string>;
  }

  /** A database's extra persistent volumes ([] when none). */
  private dbVolumes(db: Database): DbVolume[] {
    return (db.volumes as DbVolume[] | null) ?? [];
  }

  /** Set a database's extra persistent volumes (writer-only). Rejects the engine's own data dir so the
   *  managed data volume is never shadowed; name/path charset is validated by the DTO. */
  async setVolumes(userId: string, id: string, volumes: DbVolume[]): Promise<void> {
    const db = await this.requireWrite(userId, id);
    const dataDir = ENGINES[db.engine as DbEngine].dataDir;
    // Reject any path that EQUALS, nests UNDER, or CONTAINS the managed data dir — all three either shadow it,
    // leave the engine's data directory non-empty before first init, or collide as a duplicate docker mount.
    // Paths arrive canonical (DTO), so prefix comparison is exact.
    const overlaps = (p: string) => p === dataDir || p.startsWith(`${dataDir}/`) || dataDir.startsWith(`${p}/`);
    const bad = volumes.filter((v) => overlaps(v.path)).map((v) => v.path);
    if (bad.length) {
      throw new BadRequestException(`volume path overlaps the managed data volume (${dataDir}): ${bad.join(", ")}`);
    }
    await this.prisma.database.update({ where: { id }, data: { volumes: volumes as unknown as Prisma.InputJsonValue } });
    await this.audit.log({ actor: userId, action: "database.volumes.update", target: id });
  }

  /** A database's user-set env vars. Sensitive (values may be secrets), so writer-only. */
  async getEnv(userId: string, id: string): Promise<Record<string, string>> {
    const db = await this.requireWrite(userId, id);
    return this.dbEnv(db);
  }

  async setEnv(userId: string, id: string, env: Record<string, string>): Promise<void> {
    const db = await this.requireWrite(userId, id);
    const reserved = reservedDbEnvKeys(db.engine as DbEngine);
    const clash = Object.keys(env).filter((k) => reserved.has(k));
    if (clash.length) throw new BadRequestException(`reserved environment variable(s): ${clash.join(", ")}`);
    await this.prisma.database.update({
      where: { id },
      data: { envEnc: this.crypto.encrypt(JSON.stringify(env)) },
    });
    await this.audit.log({ actor: userId, action: "database.env.update", target: id });
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

  /** Raw icon bytes for the GET endpoint (read-authorized). 404 when the database has no custom icon. */
  async getIcon(userId: string, id: string): Promise<{ mime: string; data: Buffer }> {
    await this.require(userId, id);
    const icon = await this.prisma.databaseIcon.findUnique({ where: { databaseId: id } });
    if (!icon) throw new NotFoundException("no icon");
    return { mime: icon.mime, data: Buffer.from(icon.data) };
  }

  /** Store (or replace) the database's custom icon from a base64-encoded PNG. Write-authorized + validated. */
  async setIcon(userId: string, id: string, pngBase64: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    const buf = Buffer.from(pngBase64, "base64"); // tolerant decode; the PNG check below is the real gate
    if (buf.length === 0) throw new BadRequestException("icon is empty");
    validatePngIcon(buf);
    await this.prisma.$transaction([
      this.prisma.databaseIcon.upsert({
        where: { databaseId: id },
        create: { databaseId: id, mime: "image/png", data: buf, sizeBytes: buf.length },
        update: { mime: "image/png", data: buf, sizeBytes: buf.length },
      }),
      this.prisma.database.update({ where: { id }, data: { iconUpdatedAt: new Date() } }),
    ]);
    await this.audit.log({ actor: userId, action: "database.icon.set", target: db.id, meta: { sizeBytes: buf.length } });
  }

  /** Remove the database's custom icon (idempotent — a no-op when none is set). Write-authorized. */
  async deleteIcon(userId: string, id: string): Promise<void> {
    const db = await this.requireWrite(userId, id);
    await this.prisma.$transaction([
      this.prisma.databaseIcon.deleteMany({ where: { databaseId: id } }), // deleteMany: removing a missing icon is a no-op
      this.prisma.database.update({ where: { id }, data: { iconUpdatedAt: null } }),
    ]);
    await this.audit.log({ actor: userId, action: "database.icon.delete", target: db.id });
  }

  /** Effective 'databases' write permission for a member in one team (single membership read). */
  private async canWriteDatabases(userId: string, teamId: string): Promise<boolean> {
    const m = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true, teamRole: { select: { permissions: true } } },
    });
    return resolvePermissions(m).has("databases");
  }

  private view(db: Database, role: Role, canWrite: boolean, ctx?: ResourceProjectCtx, serverPublicHost?: string | null): DatabaseView {
    const spec = this.toSpec(db);
    const conn = canWrite ? connectionInfo(spec) : null;
    // A public URI only makes sense when a host port is mapped and the server has a known public
    // address; it embeds the password, so it is gated behind canWrite like connectionUri.
    const publicHost = canWrite && db.hostPort && serverPublicHost ? serverPublicHost : null;
    const publicUri = publicHost && db.hostPort ? publicConnectionUri(spec, publicHost, db.hostPort) : null;
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
      publicHost,
      publicUri,
      username: conn?.username ?? null,
      password: conn?.password ?? null,
      database: conn?.database ?? null,
      healthCmd: db.healthCmd,
      memoryMb: db.memoryMb,
      cpus: db.cpus,
      backupEnabled: db.backupEnabled,
      backupIntervalHours: db.backupIntervalHours,
      backupCron: db.backupCron,
      backupRetention: db.backupRetention,
      backupRetentionDays: db.backupRetentionDays,
      backupDestinationId: db.backupDestinationId,
      backupSupported: supportsBackup(db.engine as DbEngine),
      verifyEnabled: db.verifyEnabled,
      verifyIntervalHours: db.verifyIntervalHours,
      verifyCron: db.verifyCron,
      lastVerifiedAt: db.lastVerifiedAt,
      pitrEnabled: db.pitrEnabled,
      pitrEnabledAt: db.pitrEnabledAt,
      tags: db.tags,
      volumes: this.dbVolumes(db),
      role,
      canWrite,
      iconUpdatedAt: db.iconUpdatedAt,
      createdAt: db.createdAt,
    };
  }
}

function defaultVersion(engine: DbEngine): string {
  return ENGINES[engine].defaultVersion;
}
