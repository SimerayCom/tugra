import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { AGENT_FEATURE_HUB_ORIGIN_ENV } from "@tugra/shared";
import { Prisma, type MigrationVolumeTransfer } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { TeamAccessService } from "../../common/team-access.service";
import { AgentWsServer } from "../../agent-gateway/agent-ws.server";
import { DOCKER_ROOT, MOVE_STAGING_ROOT, MOVE_TIMEOUTS, buildMoveCleanupScript, buildMoveProbeScript, buildMoveRecvScript, hasMarker, parseMovePart, parseMoveProbe, scrubMoveOutput, type MoveProbe } from "../../app-moves/app-move-scripts";
import { createHash } from "node:crypto";
import { VolumeRelayService } from "../../app-moves/volume-relay.service";
import { diskVerdict } from "../../app-moves/move-preflight";
import { appVolumeName } from "../../deploy/deploy-script";
import { dbVolumeName } from "../../databases/database-script";
import { ImportExecutorService } from "../import-executor.service";
import { MigrationTokenService, type MigrationTokenContext } from "../migration-token.service";
import type { GateResult } from "./vx-gates";
import { dbGates, dumpDestGate, dumpDestLayout } from "./vx-dest-gate";
import { DUMP_VOLUME_NAME, VOLUME_INGEST_DUMP, VX_409, VX_PROTOCOL, VX_VOL_IDX, isStreamDumpEngine, vxDataRef, vxDumpEnabled, vxEnabled, vxMaxBytes, vxMaxDumpBytes, vxMaxParts, vxPartRawBytes, vxPrincipal, vxCommitWaitMs, vxStaleMs } from "./vx-constants";
import { VxPartRegistry, type InflightPart, type PartOutcome } from "./vx-part-registry";
import { VxApplyService } from "./vx-apply.service";
import { buildMigrationPartStatScript } from "./vx-scripts";
import { firstGate } from "./vx-dest-gate";
import { volDataRef } from "../migration-volume";
import { buildVolumeTargets, dbStreamModeRefs, dbVolumeModeRefs, parseVolumeItemRef, serviceVolumeName, volumeItemRef, type VxDbLite, type VxExclusion, type VxVolumeTarget } from "./vx-targets";
import { dumpDiskVerdict, dumpRawEstimate, type DbSizeRecord } from "./vx-dump";
import type { VxBeginBody, VxDbSizesBody, VxFinishBody, VxFingerprint, VxInventoryBody, VxInventoryItem, VxPartBody, VxRunBody, VxSpeedtestBody } from "./vx.dto";
import { buildVolumeView, type VolumeTransferView } from "./vx-view";

/** A fully resolved, re-authorized destination of ONE volume itemRef. Everything here is hub-derived, never from the migrator. */
export interface VxCtx {
  opId: string;
  actorId: string;
  hubBase?: string;
  target: VxVolumeTarget;
  targetServerId: string;
  teamId: string;
  dockerVolume: string;
  resourceType: "application" | "database";
  resourceId: string;
  /** The DONE provisioning task of the app/database this volume belongs to. */
  ownerTaskItemRef: string;
  /** db-data only: the carried-credentials flag recorded by runCreateDb. */
  credentialsCarried?: boolean;
  server: { id: string; teamId: string; capabilities: string[] };
}

export interface VxDiskResult {
  ok: boolean;
  unknown: boolean;
  details: Record<string, number | boolean | string | null>;
}

interface OpMetaVx {
  serverId?: string;
  hubBase?: string;
  plan?: { items?: unknown };
  vxInventory?: Record<string, VxInventoryItem & { runId?: string; at?: string }>;
  vxExcluded?: Record<string, VxExclusion>;
  vxDisk?: Record<string, VxDiskResult & { at?: string }>;
  /** Databases moved by the streamed dump lane (keys = database itemRefs), written by the run's DATA_SEED. */
  vxStream?: Record<string, { at: string; by: string }>;
  /** The migrator's `--measure-dbs` report by database itemRef. */
  vxDbSizes?: Record<string, DbSizeRecord>;
}

const metaOf = (m: unknown): OpMetaVx => (typeof m === "object" && m ? (m as OpMetaVx) : {});

/**
 * The migration VOLUME stream (v2): hub side. This file holds the pieces shared by every slice (resolving + re-authorizing
 * one volume itemRef from the op's DONE provisioning tasks, the target list, the inventory, the disk verdict); the transfer
 * lifecycle (begin/parts/commit/finish) lives in the same service below.
 */
@Injectable()
export class VxService {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly access: TeamAccessService,
    protected readonly executor: ImportExecutorService,
    protected readonly agentWs: AgentWsServer,
    protected readonly tokens: MigrationTokenService,
    protected readonly relay: VolumeRelayService,
    protected readonly registry: VxPartRegistry,
    protected readonly apply: VxApplyService,
  ) {}

  // ───────────────────────────── targets ─────────────────────────────

  /** Every volume the migrator may stream for this op (declared app volumes + Postgres volume-mode DBs). */
  async volumeTargetsOf(opRow: { id: string; meta: unknown; tasks: Array<{ itemRef: string | null; kind: string; status: string; resourceType: string | null; resourceId: string | null; result: unknown }> }): Promise<VxVolumeTarget[]> {
    if (!vxEnabled()) return [];
    const meta = metaOf(opRow.meta);
    const dbIds = opRow.tasks.filter((t) => t.status === "DONE" && t.resourceType === "database" && t.resourceId).map((t) => t.resourceId as string);
    const dbs = new Map<string, VxDbLite>();
    if (dbIds.length) {
      const rows = await this.prisma.database.findMany({ where: { id: { in: dbIds } }, select: { id: true, engine: true, version: true, image: true } });
      for (const r of rows) dbs.set(r.id, { id: r.id, engine: r.engine, version: r.version, image: r.image });
    }
    return buildVolumeTargets({ tasks: opRow.tasks, dbs, dbVolumeRefs: dbVolumeModeRefs(meta.plan?.items), dbStreamRefs: vxDumpEnabled() ? dbStreamModeRefs(meta) : new Set<string>(), excluded: meta.vxExcluded });
  }

  /**
   * Resolve one volume itemRef to its destination and RE-authorize the actor against the TARGET server's team. The
   * destination (app/database, server, docker volume) comes ONLY from the op's DONE provisioning task; the migrator
   * names nothing but the itemRef, and an itemRef that is not one of the op's volume targets is a uniform 404.
   */
  async resolve(opId: string, actorId: string, itemRef: string): Promise<VxCtx> {
    if (!vxEnabled()) throw new NotFoundException("no such migration target");
    if (typeof itemRef !== "string" || !parseVolumeItemRef(itemRef)) throw new NotFoundException("no such migration target");
    const opRow = await this.executor.loadIngestOp(opId, actorId);
    const meta = metaOf(opRow.meta);
    const targets = await this.volumeTargetsOf(opRow);
    const target = targets.find((t) => t.itemRef === itemRef);
    if (!target) throw new NotFoundException("no such migration target"); // 404, not 403: no itemRef oracle
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    const ownerRef = target.destType === "app-volume" ? target.appItemRef! : target.databaseItemRef!;
    const task = opRow.tasks.find((t) => t.itemRef === ownerRef && t.status === "DONE" && !!t.resourceId);
    if (!task || !task.resourceId) throw new NotFoundException("no such migration target");

    if (target.destType === "app-volume") {
      const app = await this.prisma.application.findUnique({ where: { id: task.resourceId }, select: { id: true, serverId: true, teamId: true, clusterId: true, volumes: true } });
      if (!app) throw new ConflictException("destination no longer exists");
      if (app.serverId !== (task.serverId ?? meta.serverId) || app.teamId !== server.teamId) throw new ConflictException("destination does not belong to this import");
      if (app.clusterId) throw new ConflictException("volume ingest is not supported for clustered apps");
      // A compose SERVICE has no declared Tugra volumes: its data lands in the compose project's own named volume
      // (`tugra_<appId>_<key>`, the name the service's compose file gives it), and the target row already carries the source mount.
      const declared = target.ownerKind === "service" ? { path: target.mountPath } : Array.isArray(app.volumes) ? (app.volumes as Array<{ name?: string; path?: string }>).find((v) => v?.name === target.name) : undefined;
      if (!declared || typeof declared.path !== "string") throw new NotFoundException("no such volume for this target");
      await this.access.requirePermission(actorId, server.teamId, "apps:config"); // re-authz EVERY request
      return {
        opId,
        actorId,
        hubBase: meta.hubBase,
        target: { ...target, mountPath: declared.path },
        targetServerId: app.serverId,
        teamId: app.teamId,
        dockerVolume: target.ownerKind === "service" ? serviceVolumeName(app, target.name) : appVolumeName(app, target.name),
        resourceType: "application",
        resourceId: app.id,
        ownerTaskItemRef: ownerRef,
        server: { id: server.id, teamId: server.teamId, capabilities: server.capabilities },
      };
    }

    const db = await this.prisma.database.findUnique({ where: { id: task.resourceId } });
    if (!db) throw new ConflictException("destination no longer exists");
    if (db.serverId !== (task.serverId ?? meta.serverId) || db.teamId !== server.teamId) throw new ConflictException("destination does not belong to this import");
    await this.access.requirePermission(actorId, server.teamId, "apps:config");
    await this.access.requirePermission(actorId, server.teamId, "databases");
    const res = task.result && typeof task.result === "object" ? (task.result as { credentialsCarried?: boolean }) : {};
    return {
      opId,
      actorId,
      hubBase: meta.hubBase,
      target,
      targetServerId: db.serverId,
      teamId: db.teamId,
      dockerVolume: dbVolumeName(db),
      resourceType: "database",
      resourceId: db.id,
      ownerTaskItemRef: ownerRef,
      credentialsCarried: res.credentialsCarried === true,
      server: { id: server.id, teamId: server.teamId, capabilities: server.capabilities },
    };
  }

  // ───────────────────────────── inventory (token route) ─────────────────────────────

  /**
   * Store the migrator's read-only inspection of the source volumes (size, entries, special files, running state, and for
   * Postgres the image / major / layout). It feeds the preflight and the dry-run; nothing here moves data. The whole body
   * is validated against the op's own volume targets, and the merge into `BulkOperation.meta.vxInventory` is one atomic
   * jsonb statement (no read-modify-write race with the other writers of `meta`).
   */
  async inventory(op: MigrationTokenContext, body: VxInventoryBody): Promise<{ stored: number; expiresAt: string }> {
    if (!vxEnabled()) throw new NotFoundException("no such migration target");
    const opRow = await this.executor.loadIngestOp(op.opId, op.actorId);
    const meta = metaOf(opRow.meta);
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(op.actorId, server.teamId, "apps:config");
    const targets = await this.volumeTargetsOf(opRow);
    const known = new Set(targets.map((t) => t.itemRef));
    const seen = new Set<string>();
    for (const it of body.items) {
      if (!known.has(it.itemRef)) throw new BadRequestException("the inventory names a volume that is not a target of this import");
      if (seen.has(it.itemRef)) throw new BadRequestException("the inventory lists a volume twice");
      seen.add(it.itemRef);
    }
    const at = new Date().toISOString();
    const patch: Record<string, unknown> = {};
    for (const it of body.items) patch[it.itemRef] = { ...it, runId: body.runId, at };
    await this.prisma.$executeRaw(
      Prisma.sql`UPDATE "BulkOperation" SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{vxInventory}', COALESCE("meta"->'vxInventory', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true) WHERE "id" = ${op.opId}`,
    );
    const renewed = await this.tokens.extend(op.opId);
    return { stored: body.items.length, expiresAt: (renewed ?? op.expiresAt).toISOString() };
  }

  // ───────────────────────────── disk verdict ─────────────────────────────

  /**
   * Read-only probe of the TARGET host (never the source) and the sizing verdict for `rawBytes` of tar data: compressed
   * parts (~1.0x) AND the decoded copy (~1.05x) must fit; on one filesystem both add up (the same rule app moves use).
   * An offline agent or an unreadable probe is `unknown` and NEVER `ok` (fail closed).
   */
  async diskVerdictFor(ctx: Pick<VxCtx, "targetServerId" | "dockerVolume" | "server">, rawBytes: number): Promise<VxDiskResult> {
    const p = await this.probeTarget(ctx);
    if (!p.probe) return { ok: false, unknown: true, details: { totalBytes: rawBytes, reason: p.why } };
    const stage = p.probe.df[MOVE_STAGING_ROOT];
    const dock = p.probe.df[DOCKER_ROOT];
    const v = diskVerdict({
      totalBytes: rawBytes,
      sourceStagingFreeBytes: Number.MAX_SAFE_INTEGER, // nothing is staged on the source host
      targetStagingFreeBytes: stage?.availKb != null ? stage.availKb * 1024 : null,
      targetDockerFreeBytes: dock?.availKb != null ? dock.availKb * 1024 : null,
      targetSameDevice: !!stage?.dev && !!dock?.dev && stage.dev === dock.dev,
    });
    return { ok: v.ok, unknown: v.unknown, details: v.details as VxDiskResult["details"] };
  }

  /**
   * The same read-only probe, sized for a STREAMED DUMP: the staged compressed parts plus the restored database (see
   * {@link dumpDiskVerdict}); the decoded dump never touches disk. Unknown (never ok) when the target cannot be read.
   */
  async diskVerdictForDump(ctx: Pick<VxCtx, "targetServerId" | "dockerVolume" | "server">, rawDumpBytes: number, dbBytes: number, countedGzBytes?: number | null): Promise<VxDiskResult> {
    const p = await this.probeTarget(ctx);
    if (!p.probe) return { ok: false, unknown: true, details: { totalBytes: rawDumpBytes, lane: "dump", reason: p.why } };
    const stage = p.probe.df[MOVE_STAGING_ROOT];
    const dock = p.probe.df[DOCKER_ROOT];
    return dumpDiskVerdict({
      rawDumpBytes,
      dbBytes,
      countedGzBytes,
      targetStagingFreeBytes: stage?.availKb != null ? stage.availKb * 1024 : null,
      targetDockerFreeBytes: dock?.availKb != null ? dock.availKb * 1024 : null,
      targetSameDevice: !!stage?.dev && !!dock?.dev && stage.dev === dock.dev,
    });
  }

  /** What the migrator measured for the database a dump row moves (undefined until `--measure-dbs` ran). */
  private dumpMeasure(meta: OpMetaVx, target: Pick<VxVolumeTarget, "databaseItemRef">): DbSizeRecord | undefined {
    return target.databaseItemRef ? meta.vxDbSizes?.[target.databaseItemRef] : undefined;
  }

  /**
   * The gzip size of a dump the migrator COUNTED (the real size of its staged parts); null when only the catalog size is known, or
   * when the size being checked is more than 5% above the counted dump (the database grew since: the counted ratio no longer vouches for it).
   */
  private countedGz(m: DbSizeRecord | undefined, checkedRawBytes: number): number | null {
    if (!m || m.state !== "measured" || m.dumpGzBytes === undefined || m.dumpRawBytes === undefined) return null;
    return checkedRawBytes <= m.dumpRawBytes * 1.05 ? m.dumpGzBytes : null;
  }

  /** The read-only probe of the TARGET host; `probe: null` carries WHY it is unknown (offline, old agent, no capability, bad output). */
  protected async probeTarget(ctx: Pick<VxCtx, "targetServerId" | "dockerVolume" | "server">): Promise<{ probe: MoveProbe | null; why: string }> {
    if (!ctx.server.capabilities.includes("backup")) return { probe: null, why: "the target server has no backup capability granted" };
    if (!this.agentWs.isOnline(ctx.targetServerId)) return { probe: null, why: "the target agent is offline" };
    if (!this.agentWs.agentSupports(ctx.targetServerId, AGENT_FEATURE_HUB_ORIGIN_ENV)) return { probe: null, why: "the target agent is too old for streamed copies; update it" };
    try {
      const input = { dockerVolumes: [ctx.dockerVolume] };
      const r = await this.agentWs.sendCommand(ctx.targetServerId, buildMoveProbeScript(input), "backup", MOVE_TIMEOUTS.probe);
      if (r.exitCode !== 0) return { probe: null, why: "the target probe failed" };
      const probe = parseMoveProbe(r.output, input);
      return probe ? { probe, why: "" } : { probe: null, why: "the target probe output was unusable" };
    } catch {
      return { probe: null, why: "the target agent could not be reached" };
    }
  }

  /** Persist the latest verdict next to the inventory so the wizard can show it without re-probing. */
  protected async storeDisk(opId: string, itemRef: string, v: VxDiskResult): Promise<void> {
    const entry = { ...v, at: new Date().toISOString() };
    await this.prisma.$executeRaw(
      Prisma.sql`UPDATE "BulkOperation" SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{vxDisk}', COALESCE("meta"->'vxDisk', '{}'::jsonb) || ${JSON.stringify({ [itemRef]: entry })}::jsonb, true) WHERE "id" = ${opId}`,
    );
  }

  /** Dry-run size check: against the stored inventory bytes unless `rawBytes` is given. No data moves. */
  async diskCheck(opId: string, actorId: string, itemRef: string, rawBytes?: number): Promise<VxDiskResult> {
    const ctx = await this.resolve(opId, actorId, itemRef);
    if (ctx.target.destType === "db-dump") return this.dumpDiskCheck(ctx, rawBytes);
    let bytes = rawBytes;
    if (bytes === undefined) {
      const opRow = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { meta: true } });
      bytes = metaOf(opRow?.meta).vxInventory?.[itemRef]?.rawBytes;
    }
    if (bytes === undefined) throw new ConflictException("no inventory for this volume yet: run the migrator with --dry-run first, or pass rawBytes");
    if (bytes > vxMaxBytes()) {
      return { ok: false, unknown: false, details: { totalBytes: bytes, maxBytes: vxMaxBytes(), reason: "the volume exceeds the per-volume limit" } };
    }
    const v = await this.diskVerdictFor(ctx, bytes);
    await this.storeDisk(opId, itemRef, v);
    return v;
  }

  /** Dry-run size check of a streamed dump: against the migrator's measurement unless `rawBytes` is given. No data moves. */
  private async dumpDiskCheck(ctx: VxCtx, rawBytes?: number): Promise<VxDiskResult> {
    const meta = await this.metaOfOp(ctx.opId);
    const m = this.dumpMeasure(meta, ctx.target);
    const est = rawBytes ?? dumpRawEstimate(m);
    if (est === null || est === undefined) throw new ConflictException("this database has not been measured yet: run the migrator with --dry-run --measure-dbs first, or pass rawBytes");
    if (est > vxMaxDumpBytes()) return { ok: false, unknown: false, details: { totalBytes: est, maxBytes: vxMaxDumpBytes(), lane: "dump", reason: "the dump exceeds the per-dump limit" } };
    const v = await this.diskVerdictForDump(ctx, est, m?.state === "measured" ? m.dbBytes : est, this.countedGz(m, est));
    await this.storeDisk(ctx.opId, ctx.target.itemRef, v);
    return v;
  }

  // ───────────────────────────── explicit exclusion ─────────────────────────────

  /**
   * Record that the owner does NOT want a volume migrated (the SigNoz-ClickHouse case). It needs the explicit
   * acknowledgement in the body, is stored on the op, makes /targets advertise the volume as `excluded` and the migrator
   * report it `volume-not-migrated`: a volume is never silently skipped. Re-including is the same call with `include`.
   */
  async setExcluded(userId: string, opId: string, itemRef: string, excluded: boolean, reason?: string): Promise<{ itemRef: string; excluded: boolean }> {
    const ctx = await this.resolve(opId, userId, itemRef);
    if (excluded) {
      const t = await this.prisma.migrationVolumeTransfer.findUnique({ where: { opId_itemRef: { opId, itemRef } }, select: { state: true } });
      if (t && ["COPYING", "COPIED", "APPLYING", "DONE"].includes(t.state)) throw new ConflictException("this volume is already being copied or was copied");
      const entry: VxExclusion = { reason: reason ?? "excluded by the owner", at: new Date().toISOString(), by: userId };
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "BulkOperation" SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{vxExcluded}', COALESCE("meta"->'vxExcluded', '{}'::jsonb) || ${JSON.stringify({ [itemRef]: entry })}::jsonb, true) WHERE "id" = ${opId}`,
      );
    } else {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "BulkOperation" SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{vxExcluded}', COALESCE("meta"->'vxExcluded', '{}'::jsonb) - ${itemRef}, true) WHERE "id" = ${opId}`,
      );
    }
    void ctx;
    return { itemRef, excluded };
  }

  // ───────────────────────────── /targets rows + user view ─────────────────────────────

  /** The additive `GET targets` rows of this op's volumes (secret-free: no host paths, credentials or tokens). */
  async targetRows(opRow: { id: string; meta: unknown; tasks: Array<{ itemRef: string | null; kind: string; status: string; resourceType: string | null; resourceId: string | null; result: unknown }> }): Promise<{ rows: unknown[]; volumeRefOfDb: Map<string, string> }> {
    const targets = await this.volumeTargetsOf(opRow);
    const rows: unknown[] = [];
    const volumeRefOfDb = new Map<string, string>();
    for (const t of targets) {
      if (t.destType !== "app-volume") volumeRefOfDb.set(t.databaseItemRef!, t.itemRef); // the database row is marked `dataPlane: "volume"`: its logical route is closed
      const base: Record<string, unknown> = {
        itemRef: t.itemRef,
        kind: "volume",
        volumeIngest: t.excluded ? "excluded" : t.destType === "db-dump" ? VOLUME_INGEST_DUMP : "stream-v2",
        dest: { type: t.destType, name: t.name, mountPath: t.mountPath },
      };
      if (t.excluded) base.reason = t.excluded.reason;
      if (t.destType === "app-volume") base.appItemRef = t.appItemRef;
      else Object.assign(base, { databaseItemRef: t.databaseItemRef, engine: t.engine, engineVersion: t.engineVersion, sourceImage: t.sourceImage });
      rows.push(base);
    }
    return { rows, volumeRefOfDb };
  }

  /** What `GET targets` adds at the top level for the stream. */
  targetsEnvelope(): Record<string, unknown> {
    if (!vxEnabled()) return {};
    return { vxProtocol: VX_PROTOCOL, vx: { partRawBytes: vxPartRawBytes(), maxBytes: vxMaxBytes(), maxParts: vxMaxParts(), ...(vxDumpEnabled() ? { dumpMaxBytes: vxMaxDumpBytes() } : {}) } };
  }

  // ───────────────────────────── transfer lifecycle (token routes) ─────────────────────────────

  private metaOfOp(opId: string): Promise<OpMetaVx> {
    return this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { meta: true } }).then((r) => metaOf(r?.meta));
  }

  private async expiry(op: MigrationTokenContext): Promise<string> {
    const renewed = await this.tokens.extend(op.opId).catch(() => null);
    return (renewed ?? op.expiresAt).toISOString();
  }

  private findTransfer(opId: string, itemRef: string): Promise<MigrationVolumeTransfer | null> {
    return this.prisma.migrationVolumeTransfer.findUnique({ where: { opId_itemRef: { opId, itemRef } } });
  }

  /** The migrator that holds the lease of a COPYING transfer; anything else is a 409 with the matching literal. */
  private async assertLeased(ctx: VxCtx, runId: string): Promise<MigrationVolumeTransfer> {
    const t = await this.findTransfer(ctx.opId, ctx.target.itemRef);
    if (!t) throw new NotFoundException("no such migration target");
    if (t.state === "ABORTED") throw new ConflictException(VX_409.aborted);
    if (t.runId !== runId || t.state !== "COPYING") throw new ConflictException(VX_409.otherRun);
    return t;
  }

  /** The destination must STILL be as-provisioned (a deploy or restore during a long copy aborts it). */
  private async assertDestOpen(ctx: VxCtx, inventory: VxInventoryItem | undefined): Promise<void> {
    if (ctx.target.destType === "db-dump") return this.assertDumpDestOpen(ctx);
    if (ctx.target.destType === "app-volume") {
      if ((await this.prisma.deployment.count({ where: { appId: ctx.resourceId } })) > 0) throw new ConflictException(VX_409.destDirty);
      return;
    }
    const bad = firstGate(await dbGates(this.prisma, ctx, inventory));
    if (bad) throw new ConflictException(bad.text);
  }

  /**
   * A streamed dump restores into the destination DATABASE, so it must still hold nothing that did not come from this migration: no
   * backup, no restore by anyone else, and either never started (a first claim) or started by this lane's own restore (a retry of a
   * failed apply, which Postgres rolled back and the MySQL family re-runs idempotently).
   */
  private async assertDumpDestOpen(ctx: VxCtx): Promise<void> {
    const g = await dumpDestGate(this.prisma, ctx.resourceId);
    if (!g.open) throw new ConflictException(g.reason === "gone" ? "destination no longer exists" : VX_409.destDirty);
  }

  private sameFingerprint(a: unknown, b: VxFingerprint): boolean {
    if (!a || typeof a !== "object") return false;
    const x = a as Record<string, unknown>;
    for (const k of ["containerId", "startedAt", "finishedAt", "exitCode", "mountType", "mountName", "imageId", "pgMajor"] as const) {
      if ((x[k] ?? null) !== ((b as Record<string, unknown>)[k] ?? null)) return false;
    }
    return true;
  }

  private gib(n: unknown): string {
    return typeof n === "number" ? (n / 1024 ** 3).toFixed(1) : "?";
  }

  /** Is the lease of `t` free for a migrator run `runId` to take (nobody holds it, it is ours, or its holder went silent)? */
  private leaseFree(t: MigrationVolumeTransfer, runId: string): boolean {
    if (t.state !== "COPYING") return true;
    if (!t.runId || t.runId === runId) return true;
    return !t.lastBeatAt || t.lastBeatAt.getTime() < Date.now() - vxStaleMs();
  }

  /**
   * `begin` of a streamed dump that already has a transfer row. A dump is not byte-deterministic, so unlike a tar of a stopped
   * volume it cannot be resumed from the middle by comparing raw hashes:
   *  - every part is staged (the finish was accepted) but the restore failed: re-apply it, without dumping again;
   *  - parts of an unfinished stream, from a migrator that is gone: discard them and start over (explicitly, never silently);
   *  - an attempt that staged nothing (it failed before its first part, e.g. a refused login or an unhealthy container): only its
   *    stored source fingerprint is dropped, because the operator's fix is usually to restart or recreate the source, which changes it;
   *  - a live lease held by another run: refused as always.
   */
  private async dumpBeginExisting(ctx: VxCtx, t: MigrationVolumeTransfer, body: VxBeginBody, op: MigrationTokenContext): Promise<{ view?: Record<string, unknown>; transfer: MigrationVolumeTransfer | null }> {
    if (!this.leaseFree(t, body.runId)) throw new ConflictException(VX_409.otherRun);
    if (t.state === "FAILED" && t.rawBytesFinal != null) {
      const probe = await this.apply.probeTargetState(ctx, t.id);
      if (probe && !probe.running && probe.parts === t.partsDone && t.partsDone > 0) {
        await this.assertDumpDestOpen(ctx);
        const claimed = await this.prisma.migrationVolumeTransfer.updateMany({
          where: { id: t.id, state: "FAILED" },
          data: { state: "APPLYING", runId: body.runId, lastBeatAt: new Date(), error: null, phase: "applying", finishedAt: null },
        });
        if (claimed.count !== 1) throw new ConflictException(VX_409.otherRun);
        const fresh = (await this.findTransfer(op.opId, t.itemRef))!;
        await this.setDataTask(ctx, fresh, "RUNNING", [{ name: "source-verified", status: "DONE" }, { name: "copying", status: "DONE" }, { name: "copied", status: "DONE" }, { name: "applying", status: "RUNNING" }]);
        this.apply.start(ctx, fresh);
        return { view: this.beginView(fresh, await this.expiry(op), []), transfer: fresh };
      }
    }
    if (t.partsDone > 0 || t.rawBytesFinal != null) {
      if (t.state === "COPYING" && t.runId === body.runId) return { transfer: t }; // this very run re-sent its begin (a lost answer): nothing to discard
      return { transfer: await this.restartDump(ctx, t) };
    }
    if (t.fingerprint) {
      // Nothing was staged, so nothing depends on the earlier source: the retry stores the fingerprint it begins with.
      await this.prisma.migrationVolumeTransfer.update({ where: { id: t.id }, data: { fingerprint: Prisma.DbNull } });
      return { transfer: (await this.findTransfer(t.opId, t.itemRef)) ?? t };
    }
    return { transfer: t };
  }

  /** Discard a dump's staged parts and counters so it streams again from part 0 (the destination was never touched by a copy). */
  private async restartDump(ctx: VxCtx, t: MigrationVolumeTransfer): Promise<MigrationVolumeTransfer> {
    this.registry.forget(t.id);
    if (!(await this.apply.cleanupTarget(t.id, ctx.targetServerId))) throw new ConflictException("the target could not be cleaned up (is its agent online?): try again");
    await this.prisma.$transaction([
      this.prisma.migrationVolumePart.deleteMany({ where: { transferId: t.id } }),
      this.prisma.migrationVolumeTransfer.update({
        where: { id: t.id },
        data: { attempt: { increment: 1 }, state: "PENDING", partsDone: 0, bytesDone: 0, rawBytesDone: 0, rawBytesFinal: null, entries: null, fingerprint: Prisma.DbNull, runId: null, lastBeatAt: null, phase: null, bps: null, error: null, startedAt: null, finishedAt: null },
      }),
    ]);
    await this.prisma.bulkTask.updateMany({ where: { opId: t.opId, itemRef: vxDataRef(t.itemRef) }, data: { status: "FAILED", output: "the dump starts over: a dump cannot resume from the middle", finishedAt: new Date() } });
    return (await this.findTransfer(t.opId, t.itemRef))!;
  }

  private beginView(t: MigrationVolumeTransfer, expiresAt: string, parts: Array<{ idx: number; rawOffset: bigint; rawLen: number; rawSha256: string }>, disk?: VxDiskResult | null): Record<string, unknown> {
    return {
      transferId: t.id,
      attempt: t.attempt,
      state: t.state,
      partRawBytes: t.partRawBytes,
      resumeFromPart: t.partsDone,
      manifest: parts.map((p) => ({ idx: p.idx, rawOffset: Number(p.rawOffset), rawLen: p.rawLen, rawSha256: p.rawSha256 })),
      expiresAt,
      diskVerdict: disk ? { ok: disk.ok, details: disk.details } : null,
    };
  }

  /**
   * Claim (or resume) the transfer of one volume for a migrator run. Gates first (destination still as-provisioned, no v1
   * hub-staged upload for the same volume, caps, the physical-copy gates for a Postgres volume, free space on the TARGET),
   * then ONE atomic updateMany takes the lease. The begin-time source fingerprint is stored; a later begin with a different
   * one is `vx-fingerprint-changed` (never an automatic reset).
   */
  async begin(op: MigrationTokenContext, itemRef: string, body: VxBeginBody): Promise<Record<string, unknown>> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    if (ctx.target.excluded) throw new ConflictException("this volume was excluded from the migration by its owner");
    if (body.partRawBytes !== vxPartRawBytes()) throw new BadRequestException(`partRawBytes must equal the hub policy (${vxPartRawBytes()})`);
    const isDump = ctx.target.destType === "db-dump";
    const maxRaw = isDump ? vxMaxDumpBytes() : vxMaxBytes();
    if (body.rawTotal !== undefined && body.rawTotal > maxRaw) throw new PayloadTooLargeException(`the ${isDump ? "dump" : "volume"} exceeds the ${maxRaw}-byte limit`);
    const meta = await this.metaOfOp(op.opId);
    const inv = meta.vxInventory?.[itemRef];

    if (ctx.target.destType === "app-volume") {
      // v1 hub-staged upload and the streamed copy are mutually exclusive per volume (either order).
      const v1 = await this.prisma.bulkTask.findFirst({ where: { opId: op.opId, itemRef: volDataRef(ctx.ownerTaskItemRef, ctx.target.name) }, select: { id: true } });
      if (v1) throw new ConflictException(VX_409.usesHubStaged);
    }

    let t = await this.findTransfer(op.opId, itemRef);
    if (t?.state === "DONE") return { ...this.beginView(t, await this.expiry(op), []), alreadyDone: true };
    if (t?.state === "ABORTED") throw new ConflictException(VX_409.aborted);
    if (t && (t.state === "COPIED" || t.state === "APPLYING")) return this.beginView(t, await this.expiry(op), []); // the apply is running: just poll status
    if (isDump) {
      // Refused before a byte moves (and before a re-apply of staged parts): the destination could not keep the restored database.
      const layout = await dumpDestLayout(this.prisma, ctx.resourceId);
      if (!layout.ok) throw new ConflictException(layout.reason);
    }
    if (isDump && t) {
      // A dump cannot resume from the middle (not byte-deterministic): a transfer whose parts are ALL staged is re-applied without
      // dumping again; anything else starts over, with the stale parts discarded. Neither compares the source fingerprint of the
      // earlier attempt (a restarted database is a fresh dump, not a divergence).
      const handled = await this.dumpBeginExisting(ctx, t, body, op);
      if (handled.view) return handled.view;
      t = handled.transfer;
    }
    if (t && t.fingerprint && !this.sameFingerprint(t.fingerprint, body.fingerprint)) throw new ConflictException(VX_409.fingerprintChanged);
    if (t && t.partsDone > 0 && t.partRawBytes !== body.partRawBytes) throw new ConflictException(VX_409.diverged);

    // The post-apply start of a Postgres volume failed earlier: only that step is retried (nothing is copied again).
    if (t && t.state === "FAILED" && t.phase === "provision-failed") {
      const claimed = await this.prisma.migrationVolumeTransfer.updateMany({
        where: { id: t.id, state: "FAILED", OR: [{ runId: null }, { runId: body.runId }, { lastBeatAt: { lt: new Date(Date.now() - vxStaleMs()) } }] },
        data: { state: "APPLYING", runId: body.runId, lastBeatAt: new Date(), error: null, phase: "provisioning", finishedAt: null },
      });
      if (claimed.count !== 1) throw new ConflictException(VX_409.otherRun);
      t = (await this.findTransfer(op.opId, itemRef))!;
      await this.setDataTask(ctx, t, "RUNNING", [{ name: "applied", status: "DONE" }, { name: "db-provisioned", status: "RUNNING" }]);
      this.apply.retryProvision(ctx, t);
      return this.beginView(t, await this.expiry(op), []);
    }

    // The gates run first (cheap, no agent round trip) and BEFORE the lease is taken, so a refused volume never holds one.
    await this.assertDestOpen(ctx, inv);

    // Free space on the TARGET (compressed parts + the decoded copy; for a dump: the staged parts + the restored database).
    // Skipped when parts are already staged (resume).
    const measure = isDump ? this.dumpMeasure(meta, ctx.target) : undefined;
    const bytes = body.rawTotal ?? (isDump ? (dumpRawEstimate(measure) ?? 0) : (inv?.rawBytes ?? 0));
    let disk: VxDiskResult | null = null;
    if (!t || t.partsDone === 0) {
      disk = isDump ? await this.diskVerdictForDump(ctx, bytes, measure?.state === "measured" ? measure.dbBytes : bytes, this.countedGz(measure, bytes)) : await this.diskVerdictFor(ctx, bytes);
      if (disk.unknown) throw new ConflictException(`${VX_409.diskInsufficient}: could not verify the free space on the target (${String(disk.details.reason ?? "unknown")})`);
      if (!disk.ok) {
        const d = disk.details;
        if (isDump) {
          throw new ConflictException(
            `${VX_409.diskInsufficient}: the dump needs about ${this.gib(d.stagedBytes)} GiB of staging and ${this.gib(d.databaseBytes)} GiB for the restored database (free ${this.gib(d.targetStagingFreeBytes)} GiB staging, ${this.gib(d.targetDockerFreeBytes)} GiB docker root${d.targetSameDevice ? ", one filesystem" : ""})`,
          );
        }
        throw new ConflictException(`${VX_409.diskInsufficient}: the transfer needs about ${this.gib(Math.max(Number(d.totalBytes) * 2.05 + 1024 ** 3, 0))} GiB free on one filesystem (data ${this.gib(d.totalBytes)} GiB; free ${this.gib(d.targetStagingFreeBytes)} GiB staging, ${this.gib(d.targetDockerFreeBytes)} GiB docker root)`);
      }
      await this.storeDisk(op.opId, itemRef, disk);
    }

    if (!t) {
      try {
        t = await this.prisma.migrationVolumeTransfer.create({
          data: {
            opId: op.opId,
            itemRef,
            destType: ctx.target.destType,
            targetServerId: ctx.targetServerId,
            dockerVolume: ctx.dockerVolume,
            resourceType: ctx.resourceType,
            resourceId: ctx.resourceId,
            partRawBytes: body.partRawBytes,
            rawBytesTotal: body.rawTotal ?? inv?.rawBytes ?? null,
            fingerprint: body.fingerprint as unknown as Prisma.InputJsonValue,
          },
        });
      } catch {
        t = await this.findTransfer(op.opId, itemRef); // unique race (P2002)
        if (!t) throw new ConflictException(VX_409.otherRun);
      }
    }
    const claimed = await this.prisma.migrationVolumeTransfer.updateMany({
      where: { id: t.id, state: { in: ["PENDING", "COPYING", "FAILED"] }, OR: [{ runId: null }, { runId: body.runId }, { lastBeatAt: { lt: new Date(Date.now() - vxStaleMs()) } }] },
      data: {
        runId: body.runId,
        lastBeatAt: new Date(),
        state: "COPYING",
        error: null,
        phase: "verifying",
        finishedAt: null,
        startedAt: t.startedAt ?? new Date(),
        ...(t.fingerprint ? {} : { fingerprint: body.fingerprint as unknown as Prisma.InputJsonValue }),
        ...(body.rawTotal !== undefined ? { rawBytesTotal: body.rawTotal } : {}),
      },
    });
    if (claimed.count !== 1) {
      const cur = await this.findTransfer(op.opId, itemRef);
      if (cur?.state === "DONE") return { ...this.beginView(cur, await this.expiry(op), []), alreadyDone: true };
      throw new ConflictException(VX_409.otherRun);
    }
    t = (await this.findTransfer(op.opId, itemRef))!;
    await this.setDataTask(ctx, t, "RUNNING", [{ name: "source-verified", status: "DONE" }, { name: "copying", status: "RUNNING" }]);
    const parts = t.partsDone > 0 ? await this.prisma.migrationVolumePart.findMany({ where: { transferId: t.id }, orderBy: { idx: "asc" } }) : [];
    return this.beginView(t, await this.expiry(op), parts, disk);
  }

  /** Find-or-create the `data:<itemRef>` task that mirrors the transfer; stamps the owner ref AT CLAIM (rollback guard + reaper exclusion). */
  protected async setDataTask(ctx: VxCtx, t: MigrationVolumeTransfer, status: "RUNNING" | "DONE" | "FAILED", steps: Array<{ name: string; status: string }>, extra: Record<string, unknown> = {}): Promise<void> {
    const owner = ctx.target.destType === "app-volume" ? { appItemRef: ctx.ownerTaskItemRef, volumeName: ctx.target.name } : { databaseItemRef: ctx.ownerTaskItemRef };
    const result = { vx: true, ...owner, ...extra } as Prisma.InputJsonValue;
    const ref = vxDataRef(t.itemRef);
    const existing = await this.prisma.bulkTask.findFirst({ where: { opId: t.opId, itemRef: ref }, select: { id: true } });
    if (!existing) {
      try {
        await this.prisma.bulkTask.create({ data: { opId: t.opId, serverId: ctx.targetServerId, kind: "data", itemRef: ref, status, startedAt: new Date(), steps, result } });
        return;
      } catch {
        /* unique race: fall through to the update */
      }
    }
    await this.prisma.bulkTask.updateMany({ where: { opId: t.opId, itemRef: ref }, data: { status, startedAt: new Date(), finishedAt: null, exitCode: null, output: null, steps, result } });
  }

  /** Receive-side settle of one part: the target's curl exited 0 with its marker AND the relay counted exactly the signed bytes. */
  private settlePart(reg: Pick<InflightPart, "reg" | "size" | "sha256">, recv: Promise<{ exitCode: number; output: string }>): Promise<PartOutcome> {
    return (async (): Promise<PartOutcome> => {
      try {
        const r = await recv;
        if (r.exitCode !== 0 || !hasMarker(r.output, "TUGRA_VX_RECV_OK")) {
          const tail = scrubMoveOutput(r.output).trim().split("\n").slice(-2).join(" | ");
          return { ok: false, retryable: true, reason: `target exit ${r.exitCode}: ${tail}`.slice(0, 300) };
        }
        const done = await reg.reg.done;
        if (done.bytes !== reg.size || done.sha256 !== reg.sha256) return { ok: false, retryable: true, reason: "relay counters differ from the signed part" };
        return { ok: true, bytes: done.bytes };
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        // Offline / not granted are not worth an immediate retry loop; everything else (idle, reset, sha) is retried by the migrator.
        return { ok: false, retryable: !/offline|not granted|forbidden/i.test(m), reason: scrubMoveOutput(m).slice(0, 300) };
      }
    })();
  }

  /** Persist one committed part and advance the transfer in ONE fenced transaction (replays are no-ops). */
  private async recordPart(ctx: VxCtx, t: MigrationVolumeTransfer, p: { idx: number; rawOffset: number; rawLen: number; rawSha256: string; size: number; sha256: string }, bps: number | null): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const r = await tx.migrationVolumeTransfer.updateMany({
          where: { id: t.id, runId: t.runId, state: "COPYING", partsDone: p.idx },
          data: { partsDone: { increment: 1 }, bytesDone: { increment: p.size }, rawBytesDone: { increment: p.rawLen }, lastBeatAt: new Date(), phase: "streaming", ...(bps !== null ? { bps } : {}) },
        });
        if (r.count !== 1) throw new ConflictException(VX_409.otherRun);
        await tx.migrationVolumePart.create({ data: { transferId: t.id, idx: p.idx, rawOffset: p.rawOffset, rawLen: p.rawLen, rawSha256: p.rawSha256, size: p.size, sha256: p.sha256 } });
      });
      return true;
    } catch (e) {
      if (e instanceof ConflictException) return false;
      throw e;
    }
  }

  /** Wait for `p` up to `ms`; "pending" when it is not settled yet. The timer is always cleared (no 90 s ghost per poll). */
  private async raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([p, new Promise<"pending">((r) => (timer = setTimeout(() => r("pending"), ms)))]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async registerPart(op: MigrationTokenContext, itemRef: string, idx: number, body: VxPartBody): Promise<Record<string, unknown>> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    const t = await this.assertLeased(ctx, body.runId);
    // A part call IS proof of life: renew the lease now, so a part that starts right before the stale window ends (and then crawls over a slow
    // link) is not taken over by another run while it is still being relayed.
    await this.renewLease(t);
    const meta = await this.metaOfOp(op.opId);
    await this.assertDestOpen(ctx, meta.vxInventory?.[itemRef]);
    const expiresAt = await this.expiry(op);
    if (idx < 0 || idx >= vxMaxParts()) throw new BadRequestException("part index out of range");

    if (idx < t.partsDone) {
      const row = await this.prisma.migrationVolumePart.findUnique({ where: { transferId_idx: { transferId: t.id, idx } } });
      if (row && row.rawSha256 === body.rawSha256) return { alreadyDone: true, expiresAt };
      throw new ConflictException(VX_409.diverged);
    }
    if (idx > t.partsDone) throw new ConflictException("part out of order");
    if (body.rawLen > t.partRawBytes) throw new BadRequestException("rawLen exceeds the part size");
    if (body.size > body.rawLen + Math.floor(body.rawLen / 100) + 1024) throw new BadRequestException("size exceeds the compressed bound");
    if (body.rawOffset !== Number(t.rawBytesDone)) throw new BadRequestException("rawOffset does not follow the committed parts");
    const maxRaw = ctx.target.destType === "db-dump" ? vxMaxDumpBytes() : vxMaxBytes();
    if (body.rawOffset + body.rawLen > maxRaw) throw new PayloadTooLargeException(`the ${ctx.target.destType === "db-dump" ? "dump" : "volume"} exceeds the ${maxRaw}-byte limit`);
    if (idx > 0) {
      const last = await this.prisma.migrationVolumePart.findUnique({ where: { transferId_idx: { transferId: t.id, idx: idx - 1 } } });
      if (!last || last.rawLen < t.partRawBytes) throw new ConflictException(VX_409.shortPart);
    }

    // After a hub restart the target may already hold this part (the commit was lost): verify by size + sha instead of re-sending.
    if (!this.registry.hasSeen(t.id)) {
      try {
        const r = await this.agentWs.sendCommand(ctx.targetServerId, buildMigrationPartStatScript(t.id, idx), "backup", MOVE_TIMEOUTS.stat);
        const have = r.exitCode === 0 ? parseMovePart(r.output) : null;
        if (have && have.size === body.size && have.sha256 === body.sha256) {
          this.registry.markSeen(t.id, idx);
          if (await this.recordPart(ctx, t, { idx, ...body }, null)) return { alreadyDone: true, expiresAt };
        }
      } catch {
        /* no shortcut: fall through to a normal transfer */
      }
    }

    this.registry.cancel(t.id, new Error("part re-registered"));
    const reg = this.relay.register({ moveId: t.id, volIdx: VX_VOL_IDX, part: idx, size: body.size, sha256: body.sha256, srcServerId: vxPrincipal(op.opId), dstServerId: ctx.targetServerId });
    if (reg.busy) return { busy: true };

    const recvScript = buildMoveRecvScript({ moveId: t.id, idx: VX_VOL_IDX, part: idx, path: reg.dstPath, size: body.size, sha256: body.sha256 });
    let dstReq: string | undefined;
    let aborted = false;
    const cancelDst = (): void => {
      if (dstReq) this.agentWs.cancelCommand(ctx.targetServerId, dstReq);
    };
    const recv = this.agentWs.sendCommand(ctx.targetServerId, recvScript, "backup", MOVE_TIMEOUTS.transfer, undefined, (reqId) => {
      dstReq = reqId;
      if (aborted) cancelDst();
    });
    recv.catch(() => undefined); // owned by settlePart
    reg.done.catch(() => cancelDst()); // a failed relay must not leave the target's curl waiting out its timeout
    const inflight: InflightPart = {
      transferId: t.id,
      idx,
      rawOffset: body.rawOffset,
      rawLen: body.rawLen,
      rawSha256: body.rawSha256,
      size: body.size,
      sha256: body.sha256,
      reg,
      settled: this.settlePart({ reg, size: body.size, sha256: body.sha256 }, recv),
      cancel: (reason: Error) => {
        aborted = true;
        reg.cancel(reason);
        cancelDst();
      },
      startedAt: Date.now(),
    };
    this.registry.set(inflight);
    this.watchRelayProgress(t, reg);
    return { srcPath: reg.srcPath, expiresAt };
  }

  /** Bump the lease of a transfer this run holds (fenced on the run and the COPYING state: a lost lease is never revived). */
  private async renewLease(t: Pick<MigrationVolumeTransfer, "id" | "runId">): Promise<void> {
    await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, runId: t.runId, state: "COPYING" }, data: { lastBeatAt: new Date() } });
  }

  /**
   * While a part is being relayed, keep the lease alive from the relay's own byte count: a part over a slow link can take longer than the stale
   * window, during which the migrator is busy inside one PUT and the bytes flowing are the only sign of life. Only an ADVANCING count renews it
   * (a stalled part must still go stale), and the watcher ends with the part (done, failed or cancelled).
   */
  private watchRelayProgress(t: Pick<MigrationVolumeTransfer, "id" | "runId">, reg: { done: Promise<unknown>; progress?: () => number }): void {
    if (!reg.progress) return;
    let last = reg.progress();
    const timer = setInterval(() => {
      const now = reg.progress!();
      if (now === last) return;
      last = now;
      void this.renewLease(t).catch(() => undefined);
    }, Math.max(500, Math.floor(vxStaleMs() / 4)));
    timer.unref?.();
    const stop = (): void => clearInterval(timer);
    reg.done.then(stop, stop);
  }

  async commitPart(op: MigrationTokenContext, itemRef: string, idx: number, body: VxRunBody): Promise<Record<string, unknown>> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    const t = await this.assertLeased(ctx, body.runId);
    const expiresAt = await this.expiry(op);
    const done = (partsDone: number, bytesDone: number): Record<string, unknown> => ({ done: true, partsDone, bytesDone, expiresAt });
    const inflight = this.registry.get(t.id);
    if (!inflight || inflight.idx !== idx) {
      if (idx < t.partsDone) return done(t.partsDone, Number(t.bytesDone)); // committed already (the response was lost)
      throw new ConflictException(VX_409.partLost);
    }
    const outcome = await this.raceTimeout(inflight.settled, vxCommitWaitMs());
    if (outcome === "pending") return { pending: true, expiresAt };
    if (!outcome.ok) {
      this.registry.delete(t.id, inflight);
      return { done: false, retryable: outcome.retryable, reason: outcome.reason, expiresAt };
    }
    const secs = Math.max(1, (Date.now() - inflight.startedAt) / 1000);
    const cur = inflight.rawLen / secs;
    const prev = t.bps != null ? Number(t.bps) : null;
    const bps = Math.round(prev === null ? cur : 0.7 * prev + 0.3 * cur);
    const ok = await this.recordPart(ctx, t, { idx, rawOffset: inflight.rawOffset, rawLen: inflight.rawLen, rawSha256: inflight.rawSha256, size: inflight.size, sha256: inflight.sha256 }, bps);
    this.registry.delete(t.id, inflight);
    const after = await this.findTransfer(op.opId, itemRef);
    if (!ok) {
      if (after && idx < after.partsDone) return done(after.partsDone, Number(after.bytesDone)); // a concurrent identical commit won
      throw new ConflictException(VX_409.otherRun);
    }
    // ONE progress write per commit (~230 for 29 GB), mirrored on the data task
    await this.prisma.bulkTask
      .updateMany({ where: { opId: op.opId, itemRef: vxDataRef(itemRef) }, data: { result: { vx: true, ...(ctx.target.destType === "app-volume" ? { appItemRef: ctx.ownerTaskItemRef, volumeName: ctx.target.name } : { databaseItemRef: ctx.ownerTaskItemRef }), progress: { partsDone: idx + 1, rawBytesDone: Number(t.rawBytesDone) + inflight.rawLen } } as Prisma.InputJsonValue } })
      .catch(() => undefined);
    return done(idx + 1, Number(t.bytesDone) + inflight.size);
  }

  /** After the last tar byte: validate what the hub recorded, re-check the destination and the target's space, start the apply. */
  async finish(op: MigrationTokenContext, itemRef: string, body: VxFinishBody): Promise<Record<string, unknown>> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    const t = await this.assertLeased(ctx, body.runId);
    const meta = await this.metaOfOp(op.opId);
    await this.assertDestOpen(ctx, meta.vxInventory?.[itemRef]);
    if (this.registry.get(t.id)) throw new ConflictException("a part is still in flight");
    if (body.parts !== t.partsDone) throw new BadRequestException("parts does not match the committed parts");
    const rows = await this.prisma.migrationVolumePart.findMany({ where: { transferId: t.id }, orderBy: { idx: "asc" } });
    let off = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].idx !== i || Number(rows[i].rawOffset) !== off) throw new ConflictException(VX_409.diverged); // a gap or overlap in the committed parts
      off += rows[i].rawLen;
    }
    if (rows.length !== t.partsDone || off !== body.rawBytes) throw new BadRequestException("rawBytes does not match the committed parts");
    const isDump = ctx.target.destType === "db-dump";
    if (body.rawBytes > (isDump ? vxMaxDumpBytes() : vxMaxBytes())) throw new PayloadTooLargeException(`the ${isDump ? "dump" : "volume"} exceeds the ${isDump ? vxMaxDumpBytes() : vxMaxBytes()}-byte limit`);
    const fp = t.fingerprint as { containerId?: string; startedAt?: string; finishedAt?: string } | null;
    const after = body.fingerprintAfter;
    if (isDump) {
      // The source database is RUNNING by design (a dump reads through the server): what must not have changed is that it is the
      // SAME container run (a restarted database is a different state than the one the dump began on).
      if (!fp || fp.containerId !== after.containerId || fp.startedAt !== after.startedAt) throw new ConflictException(VX_409.fingerprintChanged);
    } else if (!fp || after.running || fp.containerId !== after.containerId || fp.startedAt !== after.startedAt || fp.finishedAt !== after.finishedAt) throw new ConflictException(VX_409.fingerprintChanged);

    // Free space for the DECODED copy now that the parts are staged (the staged parts already took their share). A dump is never
    // decoded to disk: the restored database is what needs the room.
    const probe = await this.probeTarget(ctx);
    const dock = probe.probe?.df[DOCKER_ROOT];
    if (!probe.probe || dock?.availKb == null) throw new ConflictException(`${VX_409.diskInsufficient}: could not verify the free space on the target (${probe.why || "unreadable df"})`);
    const dbBytes = isDump ? (this.dumpMeasure(meta, ctx.target)?.dbBytes ?? 0) : 0;
    const need = isDump ? 1.1 * Math.max(dbBytes, body.rawBytes) + 1024 ** 3 : 1.05 * body.rawBytes + 512 * 1024 ** 2;
    if (dock.availKb * 1024 < need) throw new ConflictException(`${VX_409.diskInsufficient}: ${isDump ? "restoring" : "extracting"} needs about ${this.gib(need)} GiB free in the docker root, the target has ${this.gib(dock.availKb * 1024)} GiB`);

    const copied = await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, runId: body.runId, state: "COPYING" }, data: { state: "COPIED", rawBytesFinal: body.rawBytes, entries: body.entries, lastBeatAt: new Date(), phase: "applying" } });
    if (copied.count !== 1) throw new ConflictException(VX_409.otherRun);
    const applying = await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, state: "COPIED" }, data: { state: "APPLYING", lastBeatAt: new Date() } });
    if (applying.count !== 1) throw new ConflictException(VX_409.otherRun);
    const fresh = (await this.findTransfer(op.opId, itemRef))!;
    await this.setDataTask(ctx, fresh, "RUNNING", [{ name: "source-verified", status: "DONE" }, { name: "copying", status: "DONE" }, { name: "copied", status: "DONE" }, { name: "applying", status: "RUNNING" }]);
    this.apply.start(ctx, fresh);
    return { state: "APPLYING", expiresAt: await this.expiry(op) };
  }

  /** What the migrator polls after finish (and any time): state, progress, steps, the renewed expiry. */
  async status(op: MigrationTokenContext, itemRef: string): Promise<Record<string, unknown>> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    const t = await this.findTransfer(op.opId, itemRef);
    const expiresAt = await this.expiry(op);
    if (!t) return { state: "NONE", partsDone: 0, bytesDone: 0, rawBytesDone: 0, rawBytesTotal: null, bps: null, etaSec: null, steps: [], expiresAt };
    const task = await this.prisma.bulkTask.findFirst({ where: { opId: op.opId, itemRef: vxDataRef(itemRef) }, select: { steps: true } });
    const view = buildVolumeView({ target: ctx.target, resourceName: null, destVolume: ctx.target.name, transfer: t, inventory: undefined, disk: null, gates: null, steps: task?.steps });
    return {
      state: t.state,
      phase: t.phase,
      partsDone: view.partsDone,
      bytesDone: view.bytesDone,
      rawBytesDone: view.rawBytesDone,
      rawBytesTotal: view.rawBytesTotal,
      bps: view.bps,
      etaSec: view.etaSec,
      ...(t.error ? { error: scrubMoveOutput(t.error) } : {}),
      steps: view.steps,
      expiresAt,
    };
  }

  /** Renew the lease + token during phases that make no other call (resume-skip, inventory). */
  async beat(op: MigrationTokenContext, itemRef: string, body: VxRunBody): Promise<{ expiresAt: string }> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    const t = await this.assertLeased(ctx, body.runId);
    await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, runId: body.runId, state: "COPYING" }, data: { lastBeatAt: new Date(), ...(body.phase ? { phase: body.phase } : {}) } });
    return { expiresAt: await this.expiry(op) };
  }

  /** The migrator was interrupted: drop whatever part is in flight and release the lease, KEEPING the staged parts so the next run resumes. */
  async abort(op: MigrationTokenContext, itemRef: string, body: VxRunBody): Promise<{ state: string }> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    const t = await this.findTransfer(op.opId, itemRef);
    if (!t) throw new NotFoundException("no such migration target");
    if (t.runId !== body.runId || t.state !== "COPYING") return { state: t.state }; // nothing of ours to release
    this.registry.cancel(t.id, new Error("aborted by the migrator"));
    await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, runId: body.runId, state: "COPYING" }, data: { state: "FAILED", runId: null, error: "the migrator was interrupted; re-run it to resume", phase: null } });
    await this.setDataTask(ctx, t, "FAILED", [{ name: "source-verified", status: "DONE" }, { name: "copying", status: "FAILED" }], { progress: { partsDone: t.partsDone } });
    // The staged parts of an unfinished DUMP can never be resumed (the next begin discards them): free the target's disk now.
    if (ctx.target.destType === "db-dump" && t.rawBytesFinal == null) await this.apply.cleanupTarget(t.id, ctx.targetServerId).catch(() => false);
    return { state: "FAILED" };
  }

  /** Discard the staged parts and the destination's partial content and start over (after a divergence / fingerprint change). */
  async reset(op: MigrationTokenContext, itemRef: string, body: VxRunBody): Promise<{ state: string; attempt: number }> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    const t = await this.findTransfer(op.opId, itemRef);
    if (!t) return { state: "NONE", attempt: 1 };
    const stale = !t.lastBeatAt || t.lastBeatAt.getTime() < Date.now() - vxStaleMs();
    if (t.state === "COPYING" && t.runId && t.runId !== body.runId && !stale) throw new ConflictException(VX_409.otherRun);
    return this.doReset(ctx, t);
  }

  protected async doReset(ctx: VxCtx, t: MigrationVolumeTransfer): Promise<{ state: string; attempt: number }> {
    if (t.state === "APPLYING" || t.state === "COPIED") throw new ConflictException("an apply is running for this volume: wait for it to end");
    if (t.state === "DONE") throw new ConflictException("this volume was already applied; its data is the result of the migration");
    const meta = await this.metaOfOp(ctx.opId);
    await this.assertDestOpen(ctx, meta.vxInventory?.[t.itemRef]); // never wipe a destination that is live
    this.registry.forget(t.id);
    if (!(await this.apply.cleanupTarget(t.id, ctx.targetServerId))) throw new ConflictException("the target could not be cleaned up (is its agent online?): try again");
    if (ctx.target.destType !== "db-dump") {
      // a dump restores through the engine's own client and rolls back or re-runs idempotently: there is no volume to empty
      try {
        await this.apply.wipeDest(ctx, t.id);
      } catch (e) {
        throw new ConflictException(e instanceof Error ? e.message : "the destination could not be emptied");
      }
    }
    await this.prisma.$transaction([
      this.prisma.migrationVolumePart.deleteMany({ where: { transferId: t.id } }),
      this.prisma.migrationVolumeTransfer.update({
        where: { id: t.id },
        data: { attempt: { increment: 1 }, state: "PENDING", partsDone: 0, bytesDone: 0, rawBytesDone: 0, rawBytesFinal: null, entries: null, fingerprint: Prisma.DbNull, runId: null, lastBeatAt: null, phase: null, bps: null, error: null, startedAt: null, finishedAt: null },
      }),
    ]);
    await this.prisma.bulkTask.updateMany({ where: { opId: t.opId, itemRef: vxDataRef(t.itemRef) }, data: { status: "FAILED", output: "reset: the copy starts over", finishedAt: new Date() } });
    return { state: "PENDING", attempt: t.attempt + 1 };
  }

  // ───────────────────────────── link speed test ─────────────────────────────

  /** The throwaway staging id of one speed test: matches the move id charset and can never collide with a transfer's cuid. */
  private speedKey(opId: string, itemRef: string, runId: string): string {
    return `speed${createHash("sha256").update(`${opId}|${itemRef}|${runId}`).digest("hex").slice(0, 20)}`;
  }

  /**
   * Measure the real link: a part of the volume's FIRST MiB goes through the SAME relay and receive script a copy uses,
   * lands in a throwaway staging dir on the target (never the destination volume) and is discarded by `speedtestEnd`.
   * Read-only for the source, no lease, capped at 1 GiB staged per test. The hub times register -> target confirmation.
   */
  async speedtestPart(op: MigrationTokenContext, itemRef: string, idx: number, body: VxSpeedtestBody): Promise<Record<string, unknown>> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    if (ctx.target.excluded) throw new ConflictException("this volume was excluded from the migration by its owner");
    if (idx < 0 || idx > 99_999) throw new BadRequestException("part index out of range");
    const t = await this.findTransfer(op.opId, itemRef);
    if (t && t.state === "COPYING" && t.runId !== body.runId && t.lastBeatAt && t.lastBeatAt.getTime() >= Date.now() - vxStaleMs()) throw new ConflictException(VX_409.otherRun);
    if (body.size > vxPartRawBytes() + Math.floor(vxPartRawBytes() / 100) + 1024) throw new BadRequestException("size exceeds the part bound");
    const key = this.speedKey(op.opId, itemRef, body.runId);
    if (this.registry.speedtestBytes(key) + body.size > 1024 * 1024 ** 2) throw new PayloadTooLargeException("a speed test stages at most 1 GiB on the target");
    if (!this.agentWs.isOnline(ctx.targetServerId) || !this.agentWs.agentSupports(ctx.targetServerId, AGENT_FEATURE_HUB_ORIGIN_ENV) || !ctx.server.capabilities.includes("backup")) {
      throw new ConflictException(`${VX_409.diskInsufficient}: the target agent cannot take part in a speed test (offline, too old or no backup capability)`);
    }
    this.registry.getSpeed(key)?.cancel(new Error("speed test part re-registered"));
    const reg = this.relay.register({ moveId: key, volIdx: VX_VOL_IDX, part: idx, size: body.size, sha256: body.sha256, srcServerId: vxPrincipal(op.opId), dstServerId: ctx.targetServerId });
    if (reg.busy) return { busy: true };
    const recvScript = buildMoveRecvScript({ moveId: key, idx: VX_VOL_IDX, part: idx, path: reg.dstPath, size: body.size, sha256: body.sha256 });
    let dstReq: string | undefined;
    let aborted = false;
    const cancelDst = (): void => {
      if (dstReq) this.agentWs.cancelCommand(ctx.targetServerId, dstReq);
    };
    const recv = this.agentWs.sendCommand(ctx.targetServerId, recvScript, "backup", MOVE_TIMEOUTS.transfer, undefined, (reqId) => {
      dstReq = reqId;
      if (aborted) cancelDst();
    });
    recv.catch(() => undefined);
    reg.done.catch(() => cancelDst());
    this.registry.setSpeed({
      key,
      idx,
      size: body.size,
      reg,
      settled: this.settlePart({ reg, size: body.size, sha256: body.sha256 }, recv),
      startedAt: Date.now(),
      cancel: (reason: Error) => {
        aborted = true;
        reg.cancel(reason);
        cancelDst();
      },
    });
    return { srcPath: reg.srcPath, expiresAt: await this.expiry(op) };
  }

  async speedtestCommit(op: MigrationTokenContext, itemRef: string, idx: number, body: VxRunBody): Promise<Record<string, unknown>> {
    await this.resolve(op.opId, op.actorId, itemRef);
    const key = this.speedKey(op.opId, itemRef, body.runId);
    const part = this.registry.getSpeed(key);
    if (!part || part.idx !== idx) throw new ConflictException(VX_409.partLost);
    const outcome = await this.raceTimeout(part.settled, vxCommitWaitMs());
    if (outcome === "pending") return { pending: true };
    this.registry.deleteSpeed(key);
    if (!outcome.ok) return { done: false, retryable: outcome.retryable, reason: outcome.reason };
    return { done: true, bytes: outcome.bytes, ms: Math.max(1, Date.now() - part.startedAt) };
  }

  /** End a speed test: drop anything in flight and remove its throwaway staging on the target. */
  async speedtestEnd(op: MigrationTokenContext, itemRef: string, body: VxRunBody): Promise<{ ok: boolean }> {
    const ctx = await this.resolve(op.opId, op.actorId, itemRef);
    const key = this.speedKey(op.opId, itemRef, body.runId);
    this.registry.endSpeed(key);
    try {
      const r = await this.agentWs.sendCommand(ctx.targetServerId, buildMoveCleanupScript(key), "backup", MOVE_TIMEOUTS.drop);
      return { ok: r.exitCode === 0 };
    } catch {
      return { ok: false };
    }
  }

  // ───────────────────────────── user-authed abort / reset ─────────────────────────────

  /** The owner stops a copy from the UI: a live lease becomes ABORTED (the migrator's next call gets `vx-aborted` and exits). */
  async userAbort(userId: string, opId: string, itemRef: string): Promise<{ state: string }> {
    const ctx = await this.resolve(opId, userId, itemRef);
    const t = await this.findTransfer(opId, itemRef);
    if (!t) throw new NotFoundException("this volume has no copy to abort");
    if (t.state === "APPLYING" || t.state === "COPIED") throw new ConflictException("an apply is running for this volume: it cannot be aborted midway");
    if (t.state === "DONE") throw new ConflictException("this volume was already applied");
    this.registry.cancel(t.id, new Error("aborted by the owner"));
    await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, state: { in: ["PENDING", "COPYING", "FAILED"] } }, data: { state: "ABORTED", runId: null, phase: null, error: "aborted by the owner" } });
    await this.setDataTask(ctx, t, "FAILED", [{ name: "copying", status: "FAILED" }]);
    return { state: "ABORTED" };
  }

  /** Start the volume over: a live lease is only ABORTED (the migrator must exit first), anything else is wiped and reset. */
  async userReset(userId: string, opId: string, itemRef: string): Promise<{ state: string; attempt?: number }> {
    const ctx = await this.resolve(opId, userId, itemRef);
    const t = await this.findTransfer(opId, itemRef);
    if (!t) return { state: "NONE" };
    const live = t.state === "COPYING" && !!t.lastBeatAt && t.lastBeatAt.getTime() >= Date.now() - vxStaleMs();
    if (live) return this.userAbort(userId, opId, itemRef);
    return this.doReset(ctx, t);
  }

  /** The inventory a dump row shows: synthesized from the migrator's size report (a dump row has no volume to inspect). */
  private dumpInventory(meta: OpMetaVx, target: VxVolumeTarget): VxInventoryItem | undefined {
    const m = this.dumpMeasure(meta, target);
    const est = dumpRawEstimate(m);
    if (!m || est === null) return undefined;
    return { itemRef: target.itemRef, found: true, mountType: "volume", rawBytes: est, entries: 0, specials: { sockets: 0, fifos: 0, devices: 0 }, running: true };
  }

  // ───────────────────────────── database size report + lane switch ─────────────────────────────

  /**
   * Store the migrator's `--dry-run --measure-dbs` report (token route). Every entry must be a database this op provisioned (a DONE
   * database task) with the same engine, so the migrator can only describe databases of its own import. The merge into
   * `BulkOperation.meta.vxDbSizes` is one atomic jsonb statement. The numbers only ROUTE a database (they pick its lane); nothing
   * here moves data.
   */
  async dbSizes(op: MigrationTokenContext, body: VxDbSizesBody): Promise<{ stored: number; expiresAt: string }> {
    if (!vxDumpEnabled()) throw new NotFoundException("no such migration target");
    const opRow = await this.executor.loadIngestOp(op.opId, op.actorId);
    const meta = metaOf(opRow.meta);
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(op.actorId, server.teamId, "apps:config");
    const dbTasks = opRow.tasks.filter((t) => t.status === "DONE" && t.kind === "database" && t.resourceType === "database" && t.resourceId && t.itemRef);
    const rows = dbTasks.length ? await this.prisma.database.findMany({ where: { id: { in: dbTasks.map((t) => t.resourceId as string) } }, select: { id: true, engine: true } }) : [];
    const engineOf = new Map(rows.map((r) => [r.id, r.engine]));
    const known = new Map<string, string>();
    for (const t of dbTasks) {
      const e = engineOf.get(t.resourceId as string);
      if (e && t.itemRef) known.set(t.itemRef, e);
    }
    const seen = new Set<string>();
    for (const it of body.items) {
      if (!known.has(it.itemRef)) throw new BadRequestException("the report names a database that is not a target of this import");
      if (known.get(it.itemRef) !== it.engine) throw new BadRequestException("the reported engine does not match the provisioned database");
      if (seen.has(it.itemRef)) throw new BadRequestException("the report lists a database twice");
      seen.add(it.itemRef);
    }
    const at = new Date().toISOString();
    const patch: Record<string, unknown> = {};
    for (const it of body.items) patch[it.itemRef] = { ...it, runId: body.runId, at };
    await this.prisma.$executeRaw(
      Prisma.sql`UPDATE "BulkOperation" SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{vxDbSizes}', COALESCE("meta"->'vxDbSizes', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true) WHERE "id" = ${op.opId}`,
    );
    const renewed = await this.tokens.extend(op.opId);
    return { stored: body.items.length, expiresAt: (renewed ?? op.expiresAt).toISOString() };
  }

  /**
   * Put a database on (or take it off) the streamed dump lane. Called by the guided run's DATA_SEED once the measured dump size,
   * the engine and the owner's `largeDbMode` say so; stored as `BulkOperation.meta.vxStream` and read by every target list. The
   * lane cannot be entered once the database was already restored by the artifact route or copied as files (that data is the
   * migration's result), and only a dump-capable engine may enter it.
   */
  async setStreamMode(userId: string, opId: string, dbItemRef: string, on: boolean): Promise<{ itemRef: string; stream: boolean }> {
    if (!vxDumpEnabled()) throw new ConflictException("the streamed dump lane is switched off on this hub");
    const opRow = await this.executor.loadIngestOp(opId, userId);
    const meta = metaOf(opRow.meta);
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    await this.access.requirePermission(userId, server.teamId, "databases");
    const task = opRow.tasks.find((t) => t.itemRef === dbItemRef && t.status === "DONE" && t.kind === "database" && !!t.resourceId);
    if (!task || !task.resourceId) throw new NotFoundException("no such migration target");
    const db = await this.prisma.database.findUnique({ where: { id: task.resourceId }, select: { engine: true } });
    if (!db || !isStreamDumpEngine(db.engine)) throw new ConflictException("this database engine has no streamed dump lane");
    if (on) {
      const logical = opRow.tasks.find((t) => t.itemRef === `data:${dbItemRef}`);
      if (logical && ["DONE", "RUNNING"].includes(String(logical.status))) throw new ConflictException("this database was already restored by the artifact route");
      const physical = await this.prisma.migrationVolumeTransfer.findMany({ where: { opId, itemRef: dbItemRef.replace(/^database:/, "volume:") + ":data" }, select: { state: true } });
      if (physical.some((x) => ["COPYING", "COPIED", "APPLYING", "DONE"].includes(x.state))) throw new ConflictException("this database is already being copied as files");
      const entry = { at: new Date().toISOString(), by: userId };
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "BulkOperation" SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{vxStream}', COALESCE("meta"->'vxStream', '{}'::jsonb) || ${JSON.stringify({ [dbItemRef]: entry })}::jsonb, true) WHERE "id" = ${opId}`,
      );
      // the hub asks the target about its free space right away (it needs no migrator for that): the seed gate then reads a verdict
      try {
        const ref = volumeItemRef(dbItemRef, DUMP_VOLUME_NAME);
        if (ref) await this.dumpDiskCheck(await this.resolve(opId, userId, ref));
      } catch {
        /* unknown (agent offline, no capability...): the gate shows it as unknown and the migrator's dry run asks again */
      }
    } else {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "BulkOperation" SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{vxStream}', COALESCE("meta"->'vxStream', '{}'::jsonb) - ${dbItemRef}, true) WHERE "id" = ${opId}`,
      );
    }
    return { itemRef: dbItemRef, stream: on };
  }

  /** The user-facing per-volume view: state, progress, the migrator's inventory, the disk verdict and the db-data gates. */
  async listVolumes(userId: string, opId: string): Promise<{ volumes: VolumeTransferView[]; tokenExpiresAt: string | null; enabled: boolean }> {
    if (!vxEnabled()) return { volumes: [], tokenExpiresAt: null, enabled: false };
    const opRow = await this.executor.loadIngestOp(opId, userId);
    const meta = metaOf(opRow.meta);
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    const targets = await this.volumeTargetsOf(opRow);
    const transfers = await this.prisma.migrationVolumeTransfer.findMany({ where: { opId } });
    const byRef = new Map(transfers.map((t) => [t.itemRef, t]));
    const appIds = opRow.tasks.filter((t) => t.resourceType === "application" && t.resourceId).map((t) => t.resourceId as string);
    const dbIds = opRow.tasks.filter((t) => t.resourceType === "database" && t.resourceId).map((t) => t.resourceId as string);
    const apps = appIds.length ? await this.prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, name: true } }) : [];
    const dbs = dbIds.length ? await this.prisma.database.findMany({ where: { id: { in: dbIds } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map<string, string>([...apps, ...dbs].map((r) => [r.id, r.name]));
    const volumes: VolumeTransferView[] = [];
    for (const t of targets) {
      const ownerRef = t.destType === "app-volume" ? t.appItemRef! : t.databaseItemRef!;
      const owner = opRow.tasks.find((x) => x.itemRef === ownerRef);
      const ownerId = owner?.resourceId ?? null;
      const inv = t.destType === "db-dump" ? this.dumpInventory(meta, t) : meta.vxInventory?.[t.itemRef];
      const disk = meta.vxDisk?.[t.itemRef];
      let gates: GateResult[] | null = null;
      let destVolume = t.name;
      if (t.destType === "db-data" && ownerId) {
        const ctx: Pick<VxCtx, "resourceId" | "credentialsCarried"> = { resourceId: ownerId, credentialsCarried: (owner?.result as { credentialsCarried?: boolean } | null)?.credentialsCarried === true };
        gates = await dbGates(this.prisma, ctx, inv);
        destVolume = "data";
      }
      volumes.push(
        buildVolumeView({
          target: t,
          resourceName: ownerId ? (nameOf.get(ownerId) ?? null) : null,
          destVolume,
          transfer: byRef.get(t.itemRef) ?? null,
          inventory: inv,
          disk: disk ? { ok: disk.ok, unknown: disk.unknown, details: disk.details } : null,
          gates,
          steps: opRow.tasks.find((x) => x.itemRef === `data:${t.itemRef}`)?.steps,
        }),
      );
    }
    return { volumes, tokenExpiresAt: opRow.migrationTokenExpiresAt ? opRow.migrationTokenExpiresAt.toISOString() : null, enabled: true };
  }
}
