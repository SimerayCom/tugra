import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AGENT_FEATURE_HUB_ORIGIN_ENV } from "@tugra/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { TeamAccessService } from "../../common/team-access.service";
import { AgentWsServer } from "../../agent-gateway/agent-ws.server";
import { DOCKER_ROOT, MOVE_STAGING_ROOT, MOVE_TIMEOUTS, buildMoveProbeScript, parseMoveProbe } from "../../app-moves/app-move-scripts";
import { diskVerdict } from "../../app-moves/move-preflight";
import { appVolumeName } from "../../deploy/deploy-script";
import { dbVolumeName } from "../../databases/database-script";
import { ImportExecutorService } from "../import-executor.service";
import { MigrationTokenService, type MigrationTokenContext } from "../migration-token.service";
import { evaluateDbGates, type GateResult } from "./vx-gates";
import { VX_PROTOCOL, vxEnabled, vxMaxBytes, vxMaxParts, vxPartRawBytes } from "./vx-constants";
import { buildVolumeTargets, dbVolumeModeRefs, parseVolumeItemRef, type VxDbLite, type VxExclusion, type VxVolumeTarget } from "./vx-targets";
import type { VxInventoryBody, VxInventoryItem } from "./vx.dto";
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
    return buildVolumeTargets({ tasks: opRow.tasks, dbs, dbVolumeRefs: dbVolumeModeRefs(meta.plan?.items), excluded: meta.vxExcluded });
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
      if (app.serverId !== meta.serverId || app.teamId !== server.teamId) throw new ConflictException("destination does not belong to this import");
      if (app.clusterId) throw new ConflictException("volume ingest is not supported for clustered apps");
      const declared = Array.isArray(app.volumes) ? (app.volumes as Array<{ name?: string; path?: string }>).find((v) => v?.name === target.name) : undefined;
      if (!declared || typeof declared.path !== "string") throw new NotFoundException("no such volume for this target");
      await this.access.requirePermission(actorId, server.teamId, "apps:config"); // re-authz EVERY request
      return {
        opId,
        actorId,
        hubBase: meta.hubBase,
        target: { ...target, mountPath: declared.path },
        targetServerId: app.serverId,
        teamId: app.teamId,
        dockerVolume: appVolumeName(app, target.name),
        resourceType: "application",
        resourceId: app.id,
        ownerTaskItemRef: ownerRef,
        server: { id: server.id, teamId: server.teamId, capabilities: server.capabilities },
      };
    }

    const db = await this.prisma.database.findUnique({ where: { id: task.resourceId } });
    if (!db) throw new ConflictException("destination no longer exists");
    if (db.serverId !== meta.serverId || db.teamId !== server.teamId) throw new ConflictException("destination does not belong to this import");
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
    const unknown = (why: string): VxDiskResult => ({ ok: false, unknown: true, details: { totalBytes: rawBytes, reason: why } });
    if (!ctx.server.capabilities.includes("backup")) return unknown("the target server has no backup capability granted");
    if (!this.agentWs.isOnline(ctx.targetServerId)) return unknown("the target agent is offline");
    if (!this.agentWs.agentSupports(ctx.targetServerId, AGENT_FEATURE_HUB_ORIGIN_ENV)) return unknown("the target agent is too old for streamed copies; update it");
    try {
      const input = { dockerVolumes: [ctx.dockerVolume] };
      const r = await this.agentWs.sendCommand(ctx.targetServerId, buildMoveProbeScript(input), "backup", MOVE_TIMEOUTS.probe);
      if (r.exitCode !== 0) return unknown("the target probe failed");
      const probe = parseMoveProbe(r.output, input);
      if (!probe) return unknown("the target probe output was unusable");
      const stage = probe.df[MOVE_STAGING_ROOT];
      const dock = probe.df[DOCKER_ROOT];
      const v = diskVerdict({
        totalBytes: rawBytes,
        sourceStagingFreeBytes: Number.MAX_SAFE_INTEGER, // nothing is staged on the source host
        targetStagingFreeBytes: stage?.availKb != null ? stage.availKb * 1024 : null,
        targetDockerFreeBytes: dock?.availKb != null ? dock.availKb * 1024 : null,
        targetSameDevice: !!stage?.dev && !!dock?.dev && stage.dev === dock.dev,
      });
      return { ok: v.ok, unknown: v.unknown, details: v.details as VxDiskResult["details"] };
    } catch {
      return unknown("the target agent could not be reached");
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
      if (t.destType === "db-data") volumeRefOfDb.set(t.databaseItemRef!, t.itemRef);
      const base: Record<string, unknown> = {
        itemRef: t.itemRef,
        kind: "volume",
        volumeIngest: t.excluded ? "excluded" : "stream-v2",
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
    return { vxProtocol: VX_PROTOCOL, vx: { partRawBytes: vxPartRawBytes(), maxBytes: vxMaxBytes(), maxParts: vxMaxParts() } };
  }

  /** Gates for the db-data volume of one database (dry-run and begin share this). */
  async dbGates(ctx: VxCtx, inventory: VxInventoryItem | undefined): Promise<GateResult[]> {
    const db = await this.prisma.database.findUnique({ where: { id: ctx.resourceId }, select: { version: true, image: true, status: true } });
    if (!db) throw new ConflictException("destination no longer exists");
    const restores = await this.prisma.restore.count({ where: { databaseId: ctx.resourceId } });
    const backups = await this.prisma.backup.count({ where: { databaseId: ctx.resourceId } });
    return evaluateDbGates({ credentialsCarried: ctx.credentialsCarried, record: { version: db.version, image: db.image, status: db.status, restores, backups }, inventory });
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
      const inv = meta.vxInventory?.[t.itemRef];
      const disk = meta.vxDisk?.[t.itemRef];
      let gates: GateResult[] | null = null;
      let destVolume = t.name;
      if (t.destType === "db-data" && ownerId) {
        const ctx: Pick<VxCtx, "resourceId" | "credentialsCarried"> = { resourceId: ownerId, credentialsCarried: (owner?.result as { credentialsCarried?: boolean } | null)?.credentialsCarried === true };
        gates = await this.dbGates(ctx as VxCtx, inv);
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
