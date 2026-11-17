import { Injectable, Logger, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { PrismaService } from "../../../../prisma/prisma.service";
import { AuditService } from "../../../../audit/audit.service";
import { CryptoService } from "../../../../crypto/crypto.service";
import { ImportExecutorService } from "../../../../importer/import-executor.service";
import { containerPrefixesOf } from "../../../../importer/container-prefix";
import { foreignDbOfContainer } from "../../../../importer/sources/coolify-map";
import { MIGRATOR_ENGINES, MIGRATOR_UNSUPPORTED } from "../../../../importer/migrator-recipe";
import { VxService } from "../../../../importer/volume-stream/vx.service";
import { dbGates } from "../../../../importer/volume-stream/vx-dest-gate";
import { vxDumpEnabled, vxEnabled } from "../../../../importer/volume-stream/vx-constants";
import { buildVolumeTargets, dbStreamModeRefs, dbVolumeModeRefs, isObjectStoreResult, serviceVolumesOf, volumeItemRef, type VxVolumeTarget } from "../../../../importer/volume-stream/vx-targets";
import { dumpRawEstimate, type DbSizeRecord } from "../../../../importer/volume-stream/vx-dump";
import type { VxInventoryItem } from "../../../../importer/volume-stream/vx.dto";
import type { RunSnapshot } from "../../../core/run-contract";
import type { CarrySpec } from "../inventory/cross-check";
import { DataPortError, type DataPort, type DataSnapshot, type DbDataItem, type DbMeasureLite, type ServiceVolumeItem, type SourceItem, type VolumeDataItem, type VolumeState } from "../data-contract";
import { objectStorageFacts } from "./object-storage-facts";
import { classifyDbTaskFailure, classifyTransferError } from "../data-logic";

interface OpMeta {
  serverId?: string;
  hubBase?: string;
  plan?: { items?: unknown };
  vxInventory?: Record<string, VxInventoryItem & { runId?: string; at?: string }>;
  vxExcluded?: Record<string, { reason: string; at: string; by: string }>;
  vxDisk?: Record<string, { ok: boolean; unknown: boolean }>;
  vxStream?: Record<string, unknown>;
  vxDbSizes?: Record<string, DbSizeRecord>;
}

/**
 * Every data volume of the op's imported compose services, flagged `streamed` when the streamed lane has a target for it. A service
 * volume that is not streamed (skip / empty policy, a key or mount the stream cannot use, the lane switched off) is what VERIFY lists
 * as not migrated.
 */
function serviceVolumeItems(tasks: ReadonlyArray<{ itemRef: string | null; kind: string; status: string; resourceType: string | null; resourceId: string | null; result: unknown }>, targets: readonly VxVolumeTarget[], nameOf: ReadonlyMap<string, string>): ServiceVolumeItem[] {
  const streamed = new Set(targets.filter((t) => t.ownerKind === "service").map((t) => t.itemRef));
  const out: ServiceVolumeItem[] = [];
  for (const t of tasks) {
    if (t.kind !== "service" || t.status !== "DONE" || t.resourceType !== "application" || !t.itemRef) continue;
    const objectStore = isObjectStoreResult(t.result);
    for (const v of serviceVolumesOf(t.result)) {
      const ref = volumeItemRef(t.itemRef, v.key);
      out.push({ serviceItemRef: t.itemRef, serviceName: t.resourceId ? (nameOf.get(t.resourceId) ?? null) : null, key: v.key, policy: v.policy, streamed: !!ref && streamed.has(ref), ...(objectStore ? { objectStore: true } : {}) });
    }
  }
  return out.sort((a, b) => (a.serviceItemRef + "/" + a.key < b.serviceItemRef + "/" + b.key ? -1 : 1));
}

const metaOf = (m: unknown): OpMeta => (m && typeof m === "object" ? (m as OpMeta) : {});
const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));

/**
 * The importer's data plane as the run sees it. {@link snapshot} is READ-ONLY (plain Prisma reads: it never calls the importer's
 * op loaders, which reap stale tasks as a side effect, so a dry-run or an observe can never change the op). The few writes
 * go through the importer's own services or replicate their exact statement:
 *  - `issueToken` is `ImportExecutorService.reissueMigrationToken` (assertCanMigrate, audit, capture of the hub base),
 *  - `revokeToken` is the same `updateMany` as `MigrationTokenService.revoke` (that service is not exported by its module),
 *  - `abortTransfers` is `VxService.userAbort` resolved lazily through the module ref (VxService is not exported either), so
 *    the importer's own authorization and its "an apply is running: cannot abort" rules apply unchanged.
 */
@Injectable()
export class PrismaDataPort implements DataPort {
  private readonly logger = new Logger(PrismaDataPort.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly executor: ImportExecutorService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly crypto?: CryptoService,
  ) {}

  async snapshot(run: RunSnapshot): Promise<DataSnapshot> {
    if (!run.opId) throw new DataPortError("op-missing");
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: run.opId }, include: { tasks: true } });
    if (!op || op.kind !== "import" || op.actorId !== run.actorId) throw new DataPortError("op-missing");
    const meta = metaOf(op.meta);
    const vx = vxEnabled();
    const tasks = op.tasks;

    const dbIds = tasks.filter((t) => t.status === "DONE" && t.resourceType === "database" && t.resourceId).map((t) => t.resourceId as string);
    const appIds = tasks.filter((t) => t.status === "DONE" && t.resourceType === "application" && t.resourceId).map((t) => t.resourceId as string);
    const dbRows = dbIds.length ? await this.prisma.database.findMany({ where: { id: { in: dbIds } }, select: { id: true, name: true, engine: true, version: true, image: true } }) : [];
    const appRows = appIds.length ? await this.prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, name: true, source: true } }) : [];
    const dbById = new Map(dbRows.map((d) => [d.id, d]));
    const nameOf = new Map<string, string>([...dbRows, ...appRows].map((r) => [r.id, r.name]));
    const sourceOf = new Map(appRows.map((a) => [a.id, a.source as "IMAGE" | "GIT" | "COMPOSE"]));

    const volumeRefs = dbVolumeModeRefs(meta.plan?.items);
    const prefixOf = containerPrefixesOf(meta.plan?.items);
    const dump = vxDumpEnabled();
    const streamRefs = dump ? dbStreamModeRefs(meta) : new Set<string>();
    const targets: VxVolumeTarget[] = vx
      ? buildVolumeTargets({ tasks, dbs: new Map(dbRows.map((d) => [d.id, { id: d.id, engine: d.engine, version: d.version, image: d.image }])), dbVolumeRefs: volumeRefs, dbStreamRefs: streamRefs, excluded: meta.vxExcluded, appContainerPrefixes: prefixOf })
      : [];
    const transfers = targets.length ? await this.prisma.migrationVolumeTransfer.findMany({ where: { opId: op.id } }) : [];
    const tByRef = new Map(transfers.map((t) => [t.itemRef, t]));
    const dumpTransferOf = new Map<string, (typeof transfers)[number]>();
    for (const target of targets) if (target.destType === "db-dump" && target.databaseItemRef && tByRef.has(target.itemRef)) dumpTransferOf.set(target.databaseItemRef, tByRef.get(target.itemRef)!);

    // ── databases
    const databases: DbDataItem[] = [];
    for (const t of tasks) {
      if (t.kind !== "database" || t.resourceType !== "database" || t.status !== "DONE" || !t.resourceId || !t.itemRef) continue;
      const db = dbById.get(t.resourceId);
      if (!db) continue;
      const data = tasks.find((x) => x.itemRef === `data:${t.itemRef}`);
      const supported = MIGRATOR_ENGINES.includes(db.engine);
      const plane = !supported ? "unsupported" : vx && streamRefs.has(t.itemRef) ? "stream" : vx && volumeRefs.has(t.itemRef) ? "volume" : "logical";
      const dumpT = plane === "stream" ? dumpTransferOf.get(t.itemRef) : undefined;
      const taskState: DbDataItem["task"] = plane === "stream" ? streamTaskState(dumpT?.state) : !data ? "none" : data.status === "DONE" ? "done" : data.status === "RUNNING" || data.status === "PENDING" ? "running" : data.status === "FAILED" || data.status === "FAILED_VERIFY" ? "failed" : "none";
      databases.push({
        itemRef: t.itemRef,
        dbId: db.id,
        name: db.name,
        engine: db.engine,
        plane,
        unsupportedReason: plane === "unsupported" ? (MIGRATOR_UNSUPPORTED[db.engine] ?? "unsupported") : null,
        task: taskState,
        taskFailure: taskState === "failed" ? (plane === "stream" ? streamTaskFailure(dumpT?.error ?? null) : classifyDbTaskFailure(data?.output ?? null)) : null,
        finishedAt: taskState === "done" ? ((plane === "stream" ? dumpT?.finishedAt : data?.finishedAt)?.toISOString() ?? null) : null,
        measure: measureOf(meta.vxDbSizes?.[t.itemRef]),
      });
    }
    databases.sort((a, b) => (a.itemRef < b.itemRef ? -1 : 1));

    // ── volumes
    const volumes: VolumeDataItem[] = [];
    for (const target of targets) {
      const t = tByRef.get(target.itemRef);
      const state: VolumeState = target.excluded && !t ? "EXCLUDED" : ((t?.state as VolumeState | undefined) ?? "NONE");
      const ownerRef = target.destType === "app-volume" ? target.appItemRef! : target.databaseItemRef!;
      const owner = tasks.find((x) => x.itemRef === ownerRef);
      // a streamed dump has no volume to inspect: its "inventory" is the migrator's size report (dump size, else catalog size)
      const sized = target.destType === "db-dump" ? meta.vxDbSizes?.[target.databaseItemRef!] : undefined;
      const sizedBytes = sized ? dumpRawEstimate(sized) : null;
      const inv = target.destType === "db-dump" ? (sizedBytes === null ? undefined : { itemRef: target.itemRef, found: true, mountType: "volume" as const, rawBytes: sizedBytes, entries: 0, specials: { sockets: 0, fifos: 0, devices: 0 }, running: true }) : meta.vxInventory?.[target.itemRef];
      let gates: VolumeDataItem["gates"] = null;
      if (target.destType === "db-data" && owner?.resourceId) {
        const credsCarried = (owner.result as { credentialsCarried?: boolean } | null)?.credentialsCarried === true;
        const g = await dbGates(this.prisma, { resourceId: owner.resourceId, credentialsCarried: credsCarried }, inv);
        gates = g.map((x) => ({ id: x.id, status: x.status }));
      }
      const rawDone = num(t?.rawBytesDone);
      const rawTotal = t?.rawBytesTotal != null ? num(t.rawBytesTotal) : inv?.found ? inv.rawBytes : null;
      const bps = t?.bps != null ? num(t.bps) : null;
      volumes.push({
        itemRef: target.itemRef,
        destType: target.destType,
        ownerItemRef: target.destType === "app-volume" ? null : (target.databaseItemRef ?? null),
        engine: target.destType === "app-volume" ? null : (target.engine ?? null),
        ownerName: owner?.resourceId ? (nameOf.get(owner.resourceId) ?? null) : null,
        excluded: !!target.excluded,
        state,
        rawBytesTotal: rawTotal,
        rawBytesDone: rawDone,
        bytesDone: num(t?.bytesDone),
        bps,
        etaSec: state === "COPYING" && bps && rawTotal ? Math.ceil(Math.max(0, rawTotal - rawDone) / bps) : null,
        entries: t?.entries ?? null,
        error: t?.error ?? null,
        inventory: inv ? { found: inv.found, rawBytes: inv.rawBytes, entries: inv.entries, running: inv.running, mountType: inv.mountType, ...(inv.pgMajor ? { pgMajor: inv.pgMajor } : {}), ...(inv.pgLayout ? { pgLayout: inv.pgLayout } : {}), ...(inv.speedMBps ? { speedMBps: inv.speedMBps } : {}) } : null,
        disk: meta.vxDisk?.[target.itemRef] ? { ok: meta.vxDisk[target.itemRef].ok, unknown: meta.vxDisk[target.itemRef].unknown } : null,
        gates,
      });
    }

    const named = (kind: "app" | "service"): SourceItem[] =>
      tasks
        .filter((t) => t.status === "DONE" && t.itemRef?.startsWith(`${kind}:`))
        .map((t) => ({
          itemRef: t.itemRef as string,
          name: t.resourceId ? (nameOf.get(t.resourceId) ?? null) : null,
          ...(kind === "app" && t.resourceId && sourceOf.has(t.resourceId) ? { source: sourceOf.get(t.resourceId)! } : {}),
          ...(kind === "app" && prefixOf.has(t.itemRef as string) ? { containerPrefix: prefixOf.get(t.itemRef as string)! } : {}),
        }))
        .sort((a, b) => (a.itemRef < b.itemRef ? -1 : 1));

    const active = !!op.migrationTokenHash && !!op.migrationTokenExpiresAt && op.migrationTokenExpiresAt.getTime() > Date.now() && !op.cancelRequestedAt;
    return {
      opId: op.id,
      targetServerId: meta.serverId ?? run.targetServerId,
      vxEnabled: vx,
      dumpEnabled: dump,
      tokenActive: active,
      tokenExpiresAt: active && op.migrationTokenExpiresAt ? op.migrationTokenExpiresAt.toISOString() : null,
      hubBase: meta.hubBase ?? null,
      databases,
      volumes,
      apps: named("app"),
      services: named("service"),
      serviceVolumes: serviceVolumeItems(tasks, targets, nameOf),
      objectStorage: await objectStorageFacts(this.prisma, this.crypto, tasks, nameOf),
    };
  }

  async issueToken(run: RunSnapshot, hubBase: string): Promise<{ token: string; expiresAt: Date }> {
    if (!run.opId) throw new DataPortError("op-missing");
    try {
      // the same call the "reissue" button makes: it re-checks apps:config, captures the base and audits
      const r = await this.executor.reissueMigrationToken(run.actorId, run.opId, hubBase);
      return { token: r.token, expiresAt: r.expiresAt };
    } catch (e) {
      this.logger.warn(`run ${run.id}: migration token refused: ${e instanceof Error ? e.constructor.name : "error"}`);
      throw new DataPortError("token-rejected");
    }
  }

  async revokeToken(run: RunSnapshot): Promise<void> {
    if (!run.opId) return;
    const res = await this.prisma.bulkOperation.updateMany({ where: { id: run.opId, migrationTokenHash: { not: null } }, data: { migrationTokenHash: null, migrationTokenExpiresAt: null } });
    if (res.count > 0) await this.audit.log({ actor: run.actorId, action: "import.migration_token.revoke", target: run.opId, meta: { runId: run.id } });
  }

  async carryUnlistedDb(run: RunSnapshot, spec: CarrySpec, targetServerId: string): Promise<{ itemRef: string; created: boolean }> {
    if (!run.opId) throw new DataPortError("op-missing");
    return this.executor.carryUnlistedDb(run.actorId, run.opId, foreignDbOfContainer(spec), targetServerId);
  }

  async enableStream(run: RunSnapshot, dbItemRef: string, on: boolean): Promise<boolean> {
    if (!run.opId) return false;
    const vx = this.moduleRef.get(VxService, { strict: false });
    try {
      await vx.setStreamMode(run.actorId, run.opId, dbItemRef, on);
      return true;
    } catch (e) {
      // refused (already restored by the artifact route, copied as files, an engine with no lane, the lane switched off, no access):
      // the run reports it through its checks; nothing here changes
      this.logger.warn(`run ${run.id}: the streamed dump lane was refused for a database: ${e instanceof Error ? e.constructor.name : "error"}`);
      return false;
    }
  }

  async abortTransfers(run: RunSnapshot, itemRefs: readonly string[]): Promise<string[]> {
    if (!run.opId || itemRefs.length === 0) return [];
    const vx = this.moduleRef.get(VxService, { strict: false });
    const aborted: string[] = [];
    for (const ref of itemRefs) {
      try {
        await vx.userAbort(run.actorId, run.opId, ref);
        aborted.push(ref);
      } catch {
        /* an apply that is running cannot be aborted midway: it finishes, and the data is simply there */
      }
    }
    return aborted;
  }
}

/** The migrator's size report as the run reads it (every number is a plain integer; nothing here is a secret). */
function measureOf(m: DbSizeRecord | undefined): DbMeasureLite | null {
  if (!m) return null;
  return { state: m.state, reason: m.reason ?? null, dbBytes: m.dbBytes, dumpRawBytes: m.dumpRawBytes ?? null, dumpGzBytes: m.dumpGzBytes ?? null, measuredBy: m.measuredBy };
}

/** A database on the streamed lane has no `data:<itemRef>` task of its own: its dump transfer's state is its task state. */
function streamTaskState(state: string | undefined): DbDataItem["task"] {
  if (!state || state === "NONE") return "none";
  if (state === "DONE") return "done";
  if (state === "FAILED" || state === "ABORTED") return "failed";
  return "running";
}

function streamTaskFailure(error: string | null): string {
  const f = classifyTransferError(error);
  return f === "dest-dirty" ? "dest-dirty" : "restore-failed";
}
