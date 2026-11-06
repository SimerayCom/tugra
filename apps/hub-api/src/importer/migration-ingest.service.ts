import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  StreamableFile,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Readable } from "node:stream";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { BackupsService } from "../backups/backups.service";
import { DatabasesService } from "../databases/databases.service";
import { VolumeBackupsService } from "../volume-backups/volume-backups.service";
import { assertSafeBase } from "./migration-command";
import { isValidVolumeName, maxDecodedVolumeBytes, maxVolumeBytes, scrubVolumeTail, volStageRef, volumeTimeoutMs } from "./migration-volume";
import { buildAllMigratorRecipes, MIGRATOR_ENGINES, MIGRATOR_UNSUPPORTED, type MigratorRecipe } from "./migrator-recipe";
import { ImportExecutorService } from "./import-executor.service";
import type { MigrationTokenContext } from "./migration-token.service";
import { mintArtifactUrl, verifyArtifactSig } from "./migration-artifact";
import {
  ArtifactTooLargeError,
  assertDiskHeadroom,
  cleanupArtifact,
  DEFAULT_MAX_ARTIFACT_BYTES,
  discardPart,
  finalizePart,
  looksGzip,
  openStagedArtifact,
  readStagedMeta,
  stageToPart,
  stagedSize,
  writeStagedMeta,
  type StagedMeta,
} from "./migration-staging";

const STALE_RUNNING_MS = 10 * 60_000; // a data task RUNNING longer than this is a dead worker, re-claimable
type Step = { name: string; status: string };
type RawReq = Readable & { headers: Record<string, string | string[] | undefined> };

interface Target {
  opId: string;
  actorId: string;
  hubBase?: string; // trusted hub origin captured at mint (op.meta.hubBase) — NOT from the ingest request
  task: { id: string; itemRef: string | null; serverId: string; resourceId: string | null };
  db: { id: string; engine: string; status: string; serverId: string; teamId: string };
  serverTeamId: string;
  engine: string;
}

interface VolumeTarget {
  opId: string;
  actorId: string;
  hubBase?: string; // trusted hub origin captured at mint — NOT from the ingest request
  appTaskItemRef: string; // the app's DONE provisioning-task itemRef (the rollback-guard join key)
  app: { id: string; serverId: string; teamId: string };
  volumeName: string;
  path: string; // the declared container mount path (for the status view / staged meta)
}

/**
 * The migration DATA plane, driven by the UNTRUSTED source host (authenticated only by the migration token;
 * {@link MigrationTokenContext} gives opId + actorId, never a destination). The host streams an artifact to
 * the hub, which computes its sha256 + byte count itself, then mints a short-lived signed URL the TARGET
 * agent fetches during the EXISTING BackupsService.importFromUrl restore. Every destination is resolved
 * server-side from the op's DONE provisioning tasks, the actor is RE-authorized per request, and the agent's
 * download origin is a TRUSTED base captured at mint — never the ingest request's Host header (no SSRF).
 * S3 ships database restore; volume ingest is gated to S7.
 */
@Injectable()
export class MigrationIngestService {
  // Per-(opId:taskId) in-process guard so two concurrent PUTs for one item cannot interleave a staged file.
  private readonly uploadLocks = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly executor: ImportExecutorService,
    private readonly backups: BackupsService,
    private readonly databases: DatabasesService,
    private readonly volumeBackups: VolumeBackupsService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const s = this.config.get<string>("SECRETS_ENCRYPTION_KEY");
    if (!s) throw new Error("SECRETS_ENCRYPTION_KEY is required");
    return s;
  }

  private maxBytes(): number {
    const n = Number(process.env.MIGRATION_MAX_ARTIFACT_BYTES);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ARTIFACT_BYTES;
  }

  /**
   * The hub origin the TARGET agent fetches artifacts from. Resolved ONLY from operator/trusted config —
   * NEVER from the untrusted ingest request's headers (that would let the source host point the agent's curl
   * at an attacker origin and leak the signed URL). Precedence: MIGRATION_AGENT_HUB_URL (compose hairpin
   * override) → HUB_PUBLIC_URL → op.meta.hubBase (captured at mint from the AUTHENTICATED actor's request).
   */
  private agentBase(metaHubBase?: string): string {
    for (const candidate of [process.env.MIGRATION_AGENT_HUB_URL?.trim(), process.env.HUB_PUBLIC_URL?.trim(), metaHubBase]) {
      if (candidate) {
        assertSafeBase(candidate);
        return candidate.replace(/\/+$/, "");
      }
    }
    throw new ConflictException("the hub public URL is not configured — set HUB_PUBLIC_URL to migrate data");
  }

  /** List the data destinations this op provisioned (no resource ids, no credentials, no urls). */
  async listTargets(op: MigrationTokenContext): Promise<unknown> {
    const opRow = await this.executor.loadIngestOp(op.opId, op.actorId);
    const meta = opRow.meta as { serverId: string };
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(op.actorId, server.teamId, "apps:config");
    const targets: unknown[] = [];
    for (const t of opRow.tasks) {
      if (t.status !== "DONE" || !t.resourceId) continue;
      if (t.resourceType === "database") {
        const db = await this.prisma.database.findUnique({ where: { id: t.resourceId }, select: { engine: true } });
        if (!db) continue;
        const entry: Record<string, unknown> = { itemRef: t.itemRef, kind: "database", engine: db.engine };
        // Mark an engine the migrator cannot stream (ClickHouse/Mongo = S4b, LibSQL = no logical dump) so the
        // source skips it EXPLICITLY rather than treating a missing recipe as an empty, silently-OK dump.
        if (!MIGRATOR_ENGINES.includes(db.engine)) {
          entry.dataPlane = "unsupported";
          entry.reason = MIGRATOR_UNSUPPORTED[db.engine] ?? "unsupported";
        }
        targets.push(entry);
      } else if (t.resourceType === "application") {
        // Declared volume mounts recorded by runCopyApp (destination slug + container path; no host paths).
        // Advertise hub-staged ONLY when the declare actually SUCCEEDED (declared > 0 and no error): on a
        // setVolumes failure runCopyApp keeps `mounts` populated but sets declared=0/error, and the volume is
        // NOT in the live app.volumes column — so resolveVolumeTarget would 404 on a PUT. Don't advertise those.
        const res = t.result && typeof t.result === "object" ? (t.result as { volumes?: { mounts?: Array<{ path: string; name: string }>; declared?: number; error?: string } }).volumes : undefined;
        const declaredOk = !!res && !res.error && (res.declared ?? 0) > 0 && Array.isArray(res.mounts);
        const volumes = declaredOk ? res!.mounts!.map((m) => ({ name: m.name, path: m.path })) : [];
        targets.push({
          itemRef: t.itemRef,
          kind: "application",
          volumes,
          volumeIngest: volumes.length ? "hub-staged" : "none",
          ...(volumes.length ? {} : { reason: res?.error ? "volume declaration failed — re-run the import" : "no volume declared on this app" }),
        });
      }
    }
    return { opId: op.opId, targets, maxArtifactBytes: this.maxBytes(), maxVolumeBytes: maxVolumeBytes() };
  }

  /**
   * The per-engine dump recipes the migrator runs on the source host, plus the engines it cannot stream yet
   * (so the source skips them explicitly). Pure and SECRET-FREE — the commands carry only `$TUGRA_SRC_*`
   * references and `-e NAME` passthroughs, never a credential. Token-guarded by the controller; op-independent.
   */
  recipes(): { v: number; recipes: Record<string, MigratorRecipe>; unsupported: Record<string, string> } {
    return { v: 1, recipes: buildAllMigratorRecipes(), unsupported: MIGRATOR_UNSUPPORTED };
  }

  /**
   * Resolve one itemRef to its destination DB and RE-authorize the actor against the TARGET server's team.
   * The destination id comes ONLY from the op's DONE provisioning task (the host never names it); a mismatch,
   * a dangling record or a lost role is refused BEFORE any byte is read or any agent command is sent.
   */
  private async resolveTarget(op: MigrationTokenContext, itemRef: string): Promise<Target> {
    if (typeof itemRef !== "string" || itemRef.length === 0 || itemRef.length > 256) throw new NotFoundException("no such migration target");
    const opRow = await this.executor.loadIngestOp(op.opId, op.actorId);
    const meta = opRow.meta as { serverId: string; hubBase?: string };
    const task = await this.prisma.bulkTask.findFirst({
      where: { opId: op.opId, itemRef, status: "DONE", kind: "database", resourceType: "database" },
      select: { id: true, itemRef: true, serverId: true, resourceId: true },
    });
    if (!task || !task.resourceId) throw new NotFoundException("no such migration target"); // 404, not 403: no itemRef oracle
    const db = await this.prisma.database.findUnique({ where: { id: task.resourceId } });
    if (!db) throw new ConflictException("destination no longer exists");
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    if (db.serverId !== meta.serverId || db.teamId !== server.teamId) throw new ConflictException("destination does not belong to this import");
    // Server-ENFORCE the streamable-engine contract (not just advertise it in /targets): an engine the migrator
    // defers (ClickHouse/Mongo → S4b, LibSQL → no logical dump) is refused here too, so a non-conforming client
    // can never stage/restore a dump the restore path was never validated for.
    if (!MIGRATOR_ENGINES.includes(db.engine)) {
      throw new BadRequestException(`the migrator cannot stream ${db.engine} data yet (${MIGRATOR_UNSUPPORTED[db.engine] ?? "unsupported"})`);
    }
    // Re-authz EVERY request (not just at mint): a creator who lost the role cannot keep restoring.
    await this.access.requirePermission(op.actorId, server.teamId, "apps:config");
    await this.access.requirePermission(op.actorId, server.teamId, "databases");
    return {
      opId: op.opId,
      actorId: op.actorId,
      hubBase: meta.hubBase,
      task,
      db: { id: db.id, engine: db.engine, status: db.status, serverId: db.serverId, teamId: db.teamId },
      serverTeamId: server.teamId,
      engine: db.engine,
    };
  }

  private dataRef(itemRef: string): string {
    return `data:${itemRef}`;
  }

  /** Stream an artifact to hub staging, hashing + byte-capping it; the hub records its OWN sha256/bytes. */
  async stage(op: MigrationTokenContext, itemRef: string, req: RawReq, opts: { gzip: boolean; format?: string }): Promise<unknown> {
    const ctx = await this.resolveTarget(op, itemRef); // authz + resolution BEFORE reading the body
    const lockKey = `${op.opId}:${ctx.task.id}`;
    if (this.uploadLocks.has(lockKey)) throw new ConflictException("an upload is already in progress for this item");
    this.uploadLocks.add(lockKey);
    try {
      if (await this.dataRunning(op.opId, itemRef)) throw new ConflictException("a restore is in progress for this item");
      const ctype = String(req.headers["content-type"] ?? "");
      if (!ctype.includes("application/octet-stream")) throw new UnsupportedMediaTypeException("expected application/octet-stream");
      const len = Number(req.headers["content-length"]);
      if (!Number.isFinite(len) || len <= 0) throw new HttpException("Content-Length is required", HttpStatus.LENGTH_REQUIRED);
      const cap = this.maxBytes();
      if (len > cap) throw new PayloadTooLargeException(`artifact exceeds the ${cap}-byte cap (larger artifacts arrive in S6)`);
      await assertDiskHeadroom(len).catch((e) => {
        if ((e as { code?: string }).code === "ENOSPC") throw new HttpException("insufficient staging storage", 507);
        throw e;
      });

      let part: { bytes: number; sha256: string; head: number[]; partPath: string };
      try {
        part = await stageToPart(op.opId, ctx.task.id, req, cap);
      } catch (e) {
        if (e instanceof ArtifactTooLargeError) throw new PayloadTooLargeException("artifact exceeds the size cap");
        if ((e as { code?: string }).code === "ENOSPC") throw new HttpException("insufficient staging storage", 507);
        throw new BadRequestException("the upload did not complete"); // client abort / premature close
      }
      // Validate BEFORE promoting, so a bad upload never clobbers a previously-good staged artifact.
      try {
        if (part.bytes !== len) throw new BadRequestException("uploaded size did not match Content-Length");
        if (opts.gzip && !looksGzip(part.head)) throw new UnsupportedMediaTypeException("body is not gzip but gzip=1 was declared");
      } catch (e) {
        await discardPart(part.partPath);
        throw e;
      }
      await finalizePart(part.partPath, op.opId, ctx.task.id);
      const pgFormat = ctx.engine === "POSTGRES" ? (opts.format === "sql" ? "sql" : "custom") : undefined; // Coolify .dmp = custom
      const meta: StagedMeta = { sha256: part.sha256, bytes: part.bytes, gzip: opts.gzip, engine: ctx.engine, pgFormat, stagedAt: new Date().toISOString() };
      try {
        await writeStagedMeta(op.opId, ctx.task.id, meta);
      } catch (e) {
        await cleanupArtifact(op.opId, ctx.task.id); // keep no half-committed bin without its meta
        throw e;
      }
      await this.audit.log({ actor: op.actorId, action: "import.migration.ingest", target: op.opId, meta: { itemRef, bytes: part.bytes, sha256: part.sha256, step: "staged" } });
      return { itemRef, bytes: part.bytes, sha256: part.sha256, gzip: opts.gzip, pgFormat };
    } finally {
      this.uploadLocks.delete(lockKey);
    }
  }

  private async dataRunning(opId: string, itemRef: string): Promise<boolean> {
    const sib = await this.prisma.bulkTask.findFirst({ where: { opId, itemRef: this.dataRef(itemRef), status: "RUNNING" }, select: { startedAt: true } });
    return !!sib && !!sib.startedAt && sib.startedAt.getTime() > Date.now() - STALE_RUNNING_MS;
  }

  /** Restore the staged artifact into the destination DB (destructive, gated + idempotent). Returns 202 and
   *  runs the restore in the background; the host polls /status. */
  async restore(op: MigrationTokenContext, itemRef: string, opts: { resync: boolean }): Promise<unknown> {
    const ctx = await this.resolveTarget(op, itemRef);
    const base = this.agentBase(ctx.hubBase); // resolve + validate BEFORE the claim (a bad base never locks the item)
    const meta = await readStagedMeta(op.opId, ctx.task.id);
    if (!meta) throw new ConflictException("nothing staged for this item — upload the artifact first");
    const size = await stagedSize(op.opId, ctx.task.id);
    if (size === null || size !== meta.bytes) throw new ConflictException("the staged artifact is missing — re-upload it");

    const dataRef = this.dataRef(itemRef);
    const existing = await this.prisma.bulkTask.findFirst({ where: { opId: op.opId, itemRef: dataRef } });
    if (!existing) {
      // A fresh destination must be in its as-provisioned EMPTY state and carry no data NOT from this
      // migration — the SAME predicate rollback uses for 'used' (status!=NEW || any restore || any backup).
      const used =
        ctx.db.status !== "NEW" ||
        (await this.prisma.restore.count({ where: { databaseId: ctx.db.id } })) > 0 ||
        (await this.prisma.backup.count({ where: { databaseId: ctx.db.id } })) > 0;
      if (used) throw new ConflictException("the destination was started or holds data not restored by this migration");
    } else {
      const running = existing.status === "RUNNING" && existing.startedAt && existing.startedAt.getTime() > Date.now() - STALE_RUNNING_MS;
      if (running) throw new ConflictException("a restore is already in progress for this item");
      const prevSha = typeof existing.result === "object" && existing.result ? (existing.result as { sha256?: string }).sha256 : undefined;
      if (existing.status === "DONE" && prevSha === meta.sha256 && !opts.resync) return { state: "restored", alreadyRestored: true };
      if (existing.status === "DONE" && prevSha !== meta.sha256 && !opts.resync) {
        throw new ConflictException("a different artifact is already restored — pass resync=1 to overwrite");
      }
    }

    const now = new Date();
    const steps: Step[] = [{ name: "stage", status: "DONE" }];
    let dataTaskId: string;
    if (!existing) {
      try {
        const created = await this.prisma.bulkTask.create({
          data: { opId: op.opId, serverId: ctx.db.serverId, kind: "data", itemRef: dataRef, status: "RUNNING", startedAt: now, steps },
        });
        dataTaskId = created.id;
      } catch {
        throw new ConflictException("a restore is already in progress for this item"); // @@unique race (P2002)
      }
    } else {
      const claimed = await this.prisma.bulkTask.updateMany({
        where: { id: existing.id, OR: [{ status: { in: ["FAILED", "DONE"] } }, { status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } }] },
        data: { status: "RUNNING", startedAt: now, finishedAt: null, exitCode: null, output: null, steps },
      });
      if (claimed.count !== 1) throw new ConflictException("a restore is already in progress for this item");
      dataTaskId = existing.id;
    }

    void this.runRestore(ctx, meta, dataTaskId, itemRef, base, now).catch(() => undefined);
    return { state: "restoring" };
  }

  private async runRestore(ctx: Target, meta: StagedMeta, dataTaskId: string, itemRef: string, base: string, claimedStart: Date): Promise<void> {
    const steps: Step[] = [{ name: "stage", status: "DONE" }];
    // Terminal writes are FENCED by the claim's startedAt: if a stale-takeover re-claimed the task, our write
    // matches 0 rows and we neither overwrite the new owner nor delete the artifact it is using.
    const settle = async (data: Record<string, unknown>): Promise<boolean> => {
      const r = await this.prisma.bulkTask.updateMany({ where: { id: dataTaskId, status: "RUNNING", startedAt: claimedStart }, data });
      return r.count === 1;
    };
    const fail = async (output: string, exitCode: number | null, restoreId?: string) => {
      const won = await settle({ status: "FAILED", exitCode, output, finishedAt: new Date(), steps, result: { sha256: meta.sha256, bytes: meta.bytes, status: "FAILED", restoreId } });
      if (won) await this.audit.log({ actor: ctx.actorId, action: "import.migration.ingest", target: ctx.opId, meta: { itemRef, resourceId: ctx.db.id, status: "FAILED" } });
      // A failed restore KEEPS the staged artifact so the host can re-POST to retry without re-uploading.
    };
    let restoreClaimAt = claimedStart;
    try {
      if (ctx.db.status !== "RUNNING") {
        steps.push({ name: "provision", status: "RUNNING" });
        await this.databases.provision(ctx.actorId, ctx.db.id); // as the actor (re-checks 'databases'); S6 adds PG/Mongo readiness
        const re = await this.prisma.database.findUnique({ where: { id: ctx.db.id }, select: { status: true } });
        if (re?.status !== "RUNNING") {
          steps[steps.length - 1].status = "FAILED";
          await fail("database could not be provisioned on the target server", null);
          return;
        }
        steps[steps.length - 1].status = "DONE";
      } else {
        steps.push({ name: "provision", status: "SKIPPED" });
      }

      steps.push({ name: "restore", status: "RUNNING" });
      restoreClaimAt = new Date();
      const { url } = mintArtifactUrl(base, this.secret(), { opId: ctx.opId, taskId: ctx.task.id, sha256: meta.sha256 }, Date.now());
      await this.backups.importFromUrl(ctx.actorId, ctx.db.id, {
        url,
        gzip: meta.gzip,
        encrypted: false,
        pgFormat: ctx.engine === "POSTGRES" ? meta.pgFormat : undefined,
      });
      const row = await this.prisma.restore.findFirst({ where: { databaseId: ctx.db.id, kind: "IMPORT_URL", createdAt: { gte: restoreClaimAt } }, orderBy: { createdAt: "desc" } });
      steps[steps.length - 1].status = "DONE";
      const won = await settle({ status: "DONE", exitCode: 0, finishedAt: new Date(), steps, result: { sha256: meta.sha256, bytes: meta.bytes, status: "SUCCESS", restoreId: row?.id } });
      if (won) {
        await this.audit.log({ actor: ctx.actorId, action: "import.migration.ingest", target: ctx.opId, meta: { itemRef, resourceId: ctx.db.id, status: "SUCCESS", bytes: meta.bytes } });
        await cleanupArtifact(ctx.opId, ctx.task.id); // only a WON success removes staging (also closes the dl window)
      }
    } catch (e) {
      if (steps.length && steps[steps.length - 1].status === "RUNNING") steps[steps.length - 1].status = "FAILED";
      // importFromUrl wrote a Restore row with a SCRUBBED errorTail — prefer it, scoped to THIS attempt's window.
      const row = await this.prisma.restore.findFirst({ where: { databaseId: ctx.db.id, kind: "IMPORT_URL", createdAt: { gte: restoreClaimAt } }, orderBy: { createdAt: "desc" } }).catch(() => null);
      await fail(row?.errorTail ?? (e instanceof Error ? e.message : "restore failed"), row?.exitCode ?? null, row?.id);
    }
  }

  /** Coarse state for the source host to poll (never the scrubbed errorTail or the Restore id). */
  async status(op: MigrationTokenContext, itemRef: string): Promise<unknown> {
    const ctx = await this.resolveTarget(op, itemRef);
    const sib = await this.prisma.bulkTask.findFirst({ where: { opId: op.opId, itemRef: this.dataRef(itemRef) } });
    const meta = await readStagedMeta(op.opId, ctx.task.id);
    let state: string;
    if (sib?.status === "RUNNING") state = "restoring";
    else if (sib?.status === "DONE") state = "restored";
    else if (sib?.status === "FAILED") state = "failed";
    else state = meta ? "staged" : "none";
    const curStep = Array.isArray(sib?.steps) ? (sib!.steps as Step[]).find((s) => s.status === "RUNNING")?.name : undefined;
    return { itemRef, state, step: curStep, bytes: meta?.bytes, sha256: meta?.sha256, exitCode: sib?.exitCode ?? undefined };
  }

  /** Serve a staged artifact to the TARGET agent's curl — HMAC + sha256-bound + restore-window only. Any
   *  failure is a uniform 404 (no oracle). Called by the unguarded dl controller. */
  async serveArtifact(file: unknown, expRaw: unknown, sig: unknown): Promise<StreamableFile> {
    try {
      if (typeof file !== "string" || typeof expRaw !== "string" || typeof sig !== "string" || sig.length > 100) throw new NotFoundException();
      const m = /^([a-z0-9]{20,40})\.(bin|dump|gz)$/i.exec(file);
      const exp = Number(expRaw);
      if (!m || !Number.isInteger(exp)) throw new NotFoundException();
      const taskId = m[1];
      const task = await this.prisma.bulkTask.findUnique({ where: { id: taskId }, select: { opId: true, itemRef: true } });
      if (!task?.itemRef) throw new NotFoundException();
      const meta = await readStagedMeta(task.opId, taskId);
      if (!meta) throw new NotFoundException();
      if (!verifyArtifactSig(this.secret(), { opId: task.opId, taskId, sha256: meta.sha256 }, exp, sig, Date.now())) throw new NotFoundException();
      // The op must not have been cancelled or rolled back since the URL was minted.
      const opRow = await this.prisma.bulkOperation.findUnique({ where: { id: task.opId }, select: { cancelRequestedAt: true, meta: true } });
      const om = opRow && typeof opRow.meta === "object" && opRow.meta ? (opRow.meta as { rolledBackAt?: string }) : {};
      if (!opRow || opRow.cancelRequestedAt || om.rolledBackAt) throw new NotFoundException();
      // Restore-window capability: only servable while the sibling restore is RUNNING.
      const sib = await this.prisma.bulkTask.findFirst({ where: { opId: task.opId, itemRef: `data:${task.itemRef}`, status: "RUNNING" }, select: { id: true } });
      if (!sib) throw new NotFoundException();
      const size = await stagedSize(task.opId, taskId);
      if (size === null) throw new NotFoundException();
      return new StreamableFile(openStagedArtifact(task.opId, taskId), { type: "application/octet-stream", length: size });
    } catch {
      throw new NotFoundException(); // uniform 404 for every failure (no existence/type oracle)
    }
  }

  // ── Volume data plane (P3) ───────────────────────────────────────────────────────────────────────────
  // A hub-side clone of the DB data plane with an app-volume destination. The source host PUTs a gzip tarball
  // of ONE declared app volume to hub staging; the hub restores it through the existing
  // VolumeBackupsService.importFromUrl over an HMAC-signed URL the target agent curls. The destination (app +
  // volume) is resolved ONLY server-side from the op's DONE provisioning task — never from the host — and the
  // actor is re-authorized per request. The Go migrator automation is deferred (P3b); v1 is driven by the
  // operator's manual tar + curl (see docs/coolify-migration.md).

  /**
   * Resolve (appItemRef, volumeName) to a declared volume on the op's provisioned app and RE-authorize the
   * actor. The app id comes ONLY from the op's DONE `kind:"app"` provisioning task (the host never names it);
   * a malformed name, an unknown target/volume, a clustered app, or a lost role is refused BEFORE any byte is
   * read or any agent command is sent.
   */
  private async resolveVolumeTarget(op: MigrationTokenContext, appItemRef: string, volumeName: string): Promise<VolumeTarget> {
    if (typeof appItemRef !== "string" || appItemRef.length === 0 || appItemRef.length > 256) throw new NotFoundException("no such migration target");
    if (!isValidVolumeName(volumeName)) throw new BadRequestException("invalid volume name"); // reject traversal/charset BEFORE any work
    const opRow = await this.executor.loadIngestOp(op.opId, op.actorId);
    const meta = opRow.meta as { serverId: string; hubBase?: string };
    const task = await this.prisma.bulkTask.findFirst({
      where: { opId: op.opId, itemRef: appItemRef, status: "DONE", kind: "app", resourceType: "application" },
      select: { id: true, itemRef: true, resourceId: true },
    });
    if (!task || !task.resourceId || !task.itemRef) throw new NotFoundException("no such migration target"); // 404, not 403: no itemRef oracle
    const app = await this.prisma.application.findUnique({
      where: { id: task.resourceId },
      select: { id: true, serverId: true, teamId: true, clusterId: true, volumes: true },
    });
    if (!app) throw new ConflictException("destination no longer exists");
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    if (app.serverId !== meta.serverId || app.teamId !== server.teamId) throw new ConflictException("destination does not belong to this import");
    // A clustered app's stateful volume lives on its pinned node (constraintServerId), not app.serverId — v1
    // refuses it rather than mis-targeting the write. Coolify imports normally create non-cluster apps.
    if (app.clusterId) throw new ConflictException("volume ingest is not supported for clustered apps");
    const declared = Array.isArray(app.volumes)
      ? (app.volumes as Array<{ name?: string; path?: string }>).find((v) => v?.name === volumeName)
      : undefined;
    if (!declared || typeof declared.path !== "string") throw new NotFoundException("no such volume for this target"); // 404: no volume-name oracle
    await this.access.requirePermission(op.actorId, server.teamId, "apps:config"); // re-authz EVERY request
    return {
      opId: op.opId,
      actorId: op.actorId,
      hubBase: meta.hubBase,
      appTaskItemRef: task.itemRef,
      app: { id: app.id, serverId: app.serverId, teamId: app.teamId },
      volumeName,
      path: declared.path,
    };
  }

  /** Find-or-create the per-volume STAGING row (kind:"data", status DONE) whose cuid keys the staged file. */
  private async ensureVolumeStageRow(opId: string, serverId: string, stageRef: string): Promise<string> {
    const existing = await this.prisma.bulkTask.findFirst({ where: { opId, itemRef: stageRef }, select: { id: true } });
    if (existing) return existing.id;
    try {
      const created = await this.prisma.bulkTask.create({
        data: { opId, serverId, kind: "data", itemRef: stageRef, status: "DONE", result: { staged: true }, finishedAt: new Date() },
      });
      return created.id;
    } catch {
      const row = await this.prisma.bulkTask.findFirst({ where: { opId, itemRef: stageRef }, select: { id: true } }); // @@unique race (P2002)
      if (!row) throw new ConflictException("could not stage the volume — retry");
      return row.id;
    }
  }

  /** Stream an app-volume tarball to hub staging (gzip-capped), hashing it; the hub records its OWN sha256/bytes. */
  async stageVolume(op: MigrationTokenContext, appItemRef: string, volumeName: string, req: RawReq, opts: { gzip: boolean }): Promise<unknown> {
    const ctx = await this.resolveVolumeTarget(op, appItemRef, volumeName); // authz + resolution BEFORE reading the body
    const stageRef = volStageRef(ctx.appTaskItemRef, volumeName);
    const stageTaskId = await this.ensureVolumeStageRow(op.opId, ctx.app.serverId, stageRef);
    const lockKey = `${op.opId}:${stageTaskId}`;
    if (this.uploadLocks.has(lockKey)) throw new ConflictException("an upload is already in progress for this item");
    this.uploadLocks.add(lockKey);
    try {
      if (await this.dataRunning(op.opId, stageRef)) throw new ConflictException("a restore is in progress for this item");
      const ctype = String(req.headers["content-type"] ?? "");
      if (!ctype.includes("application/octet-stream")) throw new UnsupportedMediaTypeException("expected application/octet-stream");
      const len = Number(req.headers["content-length"]);
      if (!Number.isFinite(len) || len <= 0) throw new HttpException("Content-Length is required", HttpStatus.LENGTH_REQUIRED);
      const cap = maxVolumeBytes();
      if (len > cap) throw new PayloadTooLargeException(`the volume exceeds the ${cap}-byte cap — copy a larger volume manually (tar + rsync/scp) before the first deploy`);
      await assertDiskHeadroom(len).catch((e) => {
        if ((e as { code?: string }).code === "ENOSPC") throw new HttpException("insufficient staging storage", 507);
        throw e;
      });

      let part: { bytes: number; sha256: string; head: number[]; partPath: string };
      try {
        part = await stageToPart(op.opId, stageTaskId, req, cap);
      } catch (e) {
        if (e instanceof ArtifactTooLargeError) throw new PayloadTooLargeException("the volume exceeds the size cap");
        if ((e as { code?: string }).code === "ENOSPC") throw new HttpException("insufficient staging storage", 507);
        throw new BadRequestException("the upload did not complete");
      }
      try {
        if (part.bytes !== len) throw new BadRequestException("uploaded size did not match Content-Length");
        if (opts.gzip && !looksGzip(part.head)) throw new UnsupportedMediaTypeException("body is not gzip but gzip=1 was declared");
      } catch (e) {
        await discardPart(part.partPath);
        throw e;
      }
      await finalizePart(part.partPath, op.opId, stageTaskId);
      const meta: StagedMeta = {
        sha256: part.sha256,
        bytes: part.bytes,
        gzip: opts.gzip,
        engine: "VOLUME",
        kind: "volume",
        volume: { name: volumeName, path: ctx.path },
        appId: ctx.app.id,
        stagedAt: new Date().toISOString(),
      };
      try {
        await writeStagedMeta(op.opId, stageTaskId, meta);
      } catch (e) {
        await cleanupArtifact(op.opId, stageTaskId);
        throw e;
      }
      await this.audit.log({ actor: op.actorId, action: "import.migration.ingest", target: op.opId, meta: { itemRef: stageRef, bytes: part.bytes, sha256: part.sha256, step: "staged-volume" } });
      return { itemRef: stageRef, volume: volumeName, bytes: part.bytes, sha256: part.sha256, gzip: opts.gzip };
    } finally {
      this.uploadLocks.delete(lockKey);
    }
  }

  /** Restore a staged volume tarball into the app's docker volume (destructive wipe+extract, gated + idempotent). */
  async restoreVolume(op: MigrationTokenContext, appItemRef: string, volumeName: string, opts: { resync: boolean }): Promise<unknown> {
    const ctx = await this.resolveVolumeTarget(op, appItemRef, volumeName);
    const base = this.agentBase(ctx.hubBase); // resolve + validate BEFORE the claim
    const stageRef = volStageRef(ctx.appTaskItemRef, volumeName);
    const stageRow = await this.prisma.bulkTask.findFirst({ where: { opId: op.opId, itemRef: stageRef }, select: { id: true } });
    if (!stageRow) throw new ConflictException("nothing staged for this item — upload the artifact first");
    const stageTaskId = stageRow.id;
    const meta = await readStagedMeta(op.opId, stageTaskId);
    if (!meta) throw new ConflictException("nothing staged for this item — upload the artifact first");
    const size = await stagedSize(op.opId, stageTaskId);
    if (size === null || size !== meta.bytes) throw new ConflictException("the staged artifact is missing — re-upload it");

    // A volume restore WIPES the destination volume. Refuse once the app has EVER been deployed — even with
    // resync — because a started app may hold data not from this migration. A volume restore itself creates
    // no Deployment row, so re-syncing an as-imported (never-deployed) app stays allowed.
    if ((await this.prisma.deployment.count({ where: { appId: ctx.app.id } })) > 0) {
      throw new ConflictException("the destination was started or holds data not restored by this migration");
    }

    const dataRef = this.dataRef(stageRef);
    const existing = await this.prisma.bulkTask.findFirst({ where: { opId: op.opId, itemRef: dataRef } });
    if (existing) {
      const running = existing.status === "RUNNING" && existing.startedAt && existing.startedAt.getTime() > Date.now() - STALE_RUNNING_MS;
      if (running) throw new ConflictException("a restore is already in progress for this item");
      const prevSha = typeof existing.result === "object" && existing.result ? (existing.result as { sha256?: string }).sha256 : undefined;
      if (existing.status === "DONE" && prevSha === meta.sha256 && !opts.resync) return { state: "restored", alreadyRestored: true };
      if (existing.status === "DONE" && prevSha !== meta.sha256 && !opts.resync) {
        throw new ConflictException("a different artifact is already restored — pass resync=1 to overwrite");
      }
    }

    const now = new Date();
    const steps: Step[] = [{ name: "stage", status: "DONE" }];
    // Stamp the owning app's itemRef into result AT CLAIM TIME (not only on settle), so the rollback guard can
    // protect this app's migrated volume data even if the restore ends FAILED or the worker is stale-reaped —
    // a wipe may have already run on the agent (see runVolumeRestore), and apps.remove does `docker volume rm`.
    const claimResult = { appItemRef: ctx.appTaskItemRef, volumeName: ctx.volumeName };
    let dataTaskId: string;
    if (!existing) {
      try {
        const created = await this.prisma.bulkTask.create({
          data: { opId: op.opId, serverId: ctx.app.serverId, kind: "data", itemRef: dataRef, status: "RUNNING", startedAt: now, steps, result: claimResult },
        });
        dataTaskId = created.id;
      } catch {
        throw new ConflictException("a restore is already in progress for this item"); // @@unique race (P2002)
      }
    } else {
      const claimed = await this.prisma.bulkTask.updateMany({
        where: { id: existing.id, OR: [{ status: { in: ["FAILED", "DONE"] } }, { status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } }] },
        data: { status: "RUNNING", startedAt: now, finishedAt: null, exitCode: null, output: null, steps, result: claimResult },
      });
      if (claimed.count !== 1) throw new ConflictException("a restore is already in progress for this item");
      dataTaskId = existing.id;
    }

    void this.runVolumeRestore(ctx, meta, dataTaskId, stageTaskId, base, now).catch(() => undefined);
    return { state: "restoring" };
  }

  private async runVolumeRestore(ctx: VolumeTarget, meta: StagedMeta, dataTaskId: string, stageTaskId: string, base: string, claimedStart: Date): Promise<void> {
    const steps: Step[] = [{ name: "stage", status: "DONE" }, { name: "restore", status: "RUNNING" }];
    const stageRef = volStageRef(ctx.appTaskItemRef, ctx.volumeName);
    // Terminal writes are FENCED by the claim's startedAt: a stale-takeover re-claim makes our write match 0 rows.
    const settle = async (data: Record<string, unknown>): Promise<boolean> => {
      const r = await this.prisma.bulkTask.updateMany({ where: { id: dataTaskId, status: "RUNNING", startedAt: claimedStart }, data });
      return r.count === 1;
    };
    const fail = async (output: string, exitCode: number | null) => {
      steps[steps.length - 1].status = "FAILED";
      const won = await settle({
        status: "FAILED",
        exitCode,
        output: scrubVolumeTail(output), // never persist the signed URL curl may have echoed
        finishedAt: new Date(),
        steps,
        result: { sha256: meta.sha256, bytes: meta.bytes, status: "FAILED", appItemRef: ctx.appTaskItemRef, volumeName: ctx.volumeName },
      });
      if (won) await this.audit.log({ actor: ctx.actorId, action: "import.migration.ingest", target: ctx.opId, meta: { itemRef: stageRef, resourceId: ctx.app.id, status: "FAILED" } });
      // A failed restore KEEPS the staged artifact so the host can re-POST to retry without re-uploading.
    };
    try {
      // Re-check the deploy gate as LATE as possible (it was also checked at POST): the wipe+extract is
      // destructive, so a deploy that started a container on the volume AFTER the 202 must still abort the
      // wipe. This shrinks the TOCTOU window to the sendCommand round-trip (fully closing it would require the
      // deploy path to refuse while a data task is RUNNING — deferred to a later phase).
      if ((await this.prisma.deployment.count({ where: { appId: ctx.app.id } })) > 0) {
        await fail("the app was deployed during the restore window — refusing to wipe a live volume", null);
        return;
      }
      const { url } = mintArtifactUrl(base, this.secret(), { opId: ctx.opId, taskId: stageTaskId, sha256: meta.sha256 }, Date.now());
      const res = await this.volumeBackups.importFromUrlDetailed(
        ctx.actorId,
        ctx.app.id,
        { volumeName: ctx.volumeName, url, gzip: meta.gzip, encrypted: false },
        { timeoutMs: volumeTimeoutMs(meta.bytes), maxDecodedBytes: maxDecodedVolumeBytes(meta.bytes) },
      );
      if (!res.ok) {
        // The wipe+extract may have run partially before the agent reported failure → tell the operator not to deploy yet.
        await fail(res.tail || "volume restore failed — the volume may be partial, re-run restore before the first deploy", res.exitCode);
        return;
      }
      steps[steps.length - 1].status = "DONE";
      const won = await settle({
        status: "DONE",
        exitCode: 0,
        finishedAt: new Date(),
        steps,
        result: { sha256: meta.sha256, bytes: meta.bytes, status: "SUCCESS", appItemRef: ctx.appTaskItemRef, volumeName: ctx.volumeName },
      });
      if (won) {
        await this.audit.log({ actor: ctx.actorId, action: "import.migration.ingest", target: ctx.opId, meta: { itemRef: stageRef, resourceId: ctx.app.id, status: "SUCCESS", bytes: meta.bytes } });
        await cleanupArtifact(ctx.opId, stageTaskId); // only a WON success removes staging (closes the dl window)
      }
    } catch (e) {
      await fail(e instanceof Error ? e.message : "restore failed", null);
    }
  }

  /** Coarse per-volume state for the source host to poll (never a leaked tail). */
  async volumeStatus(op: MigrationTokenContext, appItemRef: string, volumeName: string): Promise<unknown> {
    const ctx = await this.resolveVolumeTarget(op, appItemRef, volumeName);
    const stageRef = volStageRef(ctx.appTaskItemRef, volumeName);
    const stageRow = await this.prisma.bulkTask.findFirst({ where: { opId: op.opId, itemRef: stageRef }, select: { id: true } });
    const sib = await this.prisma.bulkTask.findFirst({ where: { opId: op.opId, itemRef: this.dataRef(stageRef) } });
    const meta = stageRow ? await readStagedMeta(op.opId, stageRow.id) : null;
    let state: string;
    if (sib?.status === "RUNNING") state = "restoring";
    else if (sib?.status === "DONE") state = "restored";
    else if (sib?.status === "FAILED") state = "failed";
    else state = meta ? "staged" : "none";
    const curStep = Array.isArray(sib?.steps) ? (sib!.steps as Step[]).find((s) => s.status === "RUNNING")?.name : undefined;
    return { itemRef: stageRef, volume: volumeName, state, step: curStep, bytes: meta?.bytes, sha256: meta?.sha256, exitCode: sib?.exitCode ?? undefined, ownership: "not-preserved" };
  }
}
