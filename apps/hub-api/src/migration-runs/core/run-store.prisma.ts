import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { OPEN_STATUSES } from "./run-logic";
import { RunLeaseLostError, LIVE_RUN_STATUSES, type RunStatus, type StepKey, type StepStatus } from "./run-contract";
import {
  ServerHasLiveRunError,
  type EventInput,
  type EventRow,
  type ListRunsFilter,
  type NewRun,
  type NewStep,
  type RunGuard,
  type RunPatch,
  type RunRow,
  type RunStore,
  type StepPatch,
  type StepRow,
} from "./run-store";

/** `null` clears a JSON column (SQL NULL), `undefined` leaves it out, anything else is stored as JSON. */
const json = (v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined => (v === undefined ? undefined : v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));

const isUnique = (e: unknown, field?: string): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && (!field || String(e.meta?.target ?? "").includes(field));
/** A unique violation on the run's `activeKey` or on a server-lock row (primary key `serverId`). */
const isLockClash = (e: unknown): boolean => isUnique(e, "activeKey") || isUnique(e, "serverId") || isUnique(e, "MigrationRunServerLock");
const isNotFound = (e: unknown): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";

const JSON_RUN_COLUMNS = new Set(["inputs", "windowEstimate", "report", "sourceBaseline", "serverMap"]);

function runData(p: RunPatch): Prisma.MigrationRunUncheckedUpdateManyInput {
  const out: Prisma.MigrationRunUncheckedUpdateManyInput = {};
  const o = out as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || k === "lockServerIds") continue; // lockServerIds is a store directive, not a column
    o[k] = JSON_RUN_COLUMNS.has(k) ? json(v) : v;
  }
  return out;
}

/** The server id an `activeKey` (`srv:<id>`) names. */
const serverOfKey = (key: string): string => key.replace(/^srv:/, "");

function stepData(p: StepPatch): Prisma.MigrationRunStepUncheckedUpdateManyInput {
  const out: Prisma.MigrationRunStepUncheckedUpdateManyInput = {};
  const o = out as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    o[k] = ["gate", "approval", "progress", "compensation", "evidence", "wait"].includes(k) ? json(v) : v;
  }
  return out;
}

/** Production {@link RunStore}: plain Prisma, every state change a compare-and-set (`updateMany` with a guard in `where`). */
@Injectable()
export class PrismaRunStore implements RunStore {
  constructor(private readonly prisma: PrismaService) {}

  async create(run: NewRun, steps: readonly NewStep[], status: RunStatus): Promise<RunRow> {
    const locks = [...new Set(run.lockServerIds ?? (run.activeKey ? [serverOfKey(run.activeKey)] : []))];
    try {
      return await this.prisma.migrationRun.create({
        data: {
          teamId: run.teamId,
          actorId: run.actorId,
          targetServerId: run.targetServerId,
          ...(run.serverMap && Object.keys(run.serverMap).length ? { serverMap: json(run.serverMap) as Prisma.InputJsonValue } : {}),
          sourceKind: run.sourceKind,
          sourceHost: run.sourceHost,
          ...(run.sourceVersion ? { sourceVersion: run.sourceVersion } : {}),
          ...(run.agentServerId ? { agentServerId: run.agentServerId } : {}),
          ...(run.sourceTeamRef ? { sourceTeamRef: run.sourceTeamRef } : {}),
          ...(run.campaign ? { campaign: run.campaign } : {}),
          ...(run.inPlace ? { inPlace: true } : {}),
          sessionId: run.sessionId,
          planHash: run.planHash,
          mode: run.mode,
          topology: run.topology,
          dryRun: run.dryRun,
          promotedFromId: run.promotedFromId,
          applyInput: json(run.applyInput) as Prisma.InputJsonValue,
          options: json(run.options) as Prisma.InputJsonValue,
          inputs: json(run.inputs) as Prisma.InputJsonValue,
          activeKey: run.activeKey,
          status,
          steps: { create: steps.map((s) => ({ key: s.key, idx: s.idx, kind: s.kind, rollbackClass: s.rollbackClass })) },
          ...(locks.length ? { serverLocks: { create: locks.map((serverId) => ({ serverId })) } } : {}),
        },
      });
    } catch (e) {
      if (isLockClash(e)) throw new ServerHasLiveRunError();
      throw e;
    }
  }

  get(id: string): Promise<RunRow | null> {
    return this.prisma.migrationRun.findUnique({ where: { id } });
  }

  steps(runId: string): Promise<StepRow[]> {
    return this.prisma.migrationRunStep.findMany({ where: { runId }, orderBy: { idx: "asc" } });
  }

  stepsOf(runIds: readonly string[]): Promise<StepRow[]> {
    if (!runIds.length) return Promise.resolve([]);
    return this.prisma.migrationRunStep.findMany({ where: { runId: { in: [...runIds] } }, orderBy: { idx: "asc" } });
  }

  list(f: ListRunsFilter): Promise<RunRow[]> {
    return this.prisma.migrationRun.findMany({
      where: {
        actorId: f.actorId,
        teamId: f.teamId ? (f.teamIds.includes(f.teamId) ? f.teamId : "\u0000none") : { in: [...f.teamIds] },
        ...(f.status ? { status: f.status } : {}),
        ...(f.live ? { status: { in: [...LIVE_RUN_STATUSES] } } : {}),
        ...(f.campaign ? { campaign: f.campaign } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: f.limit,
    });
  }

  drivable(): Promise<RunRow[]> {
    return this.prisma.migrationRun.findMany({ where: { status: { in: ["RUNNING", "WAITING", "ABORTING", "ROLLING_BACK", "REVERSING"] } }, orderBy: { createdAt: "asc" } });
  }

  async openSessionIds(): Promise<string[]> {
    const rows = await this.prisma.migrationRun.findMany({ where: { status: { in: [...OPEN_STATUSES] }, sessionId: { not: null } }, select: { sessionId: true }, distinct: ["sessionId"], take: 500 });
    return rows.flatMap((r) => (r.sessionId ? [r.sessionId] : []));
  }

  manualInFlight(): Promise<StepRow[]> {
    return this.prisma.migrationRunStep.findMany({
      where: { key: "DECOMMISSION", status: { in: ["RUNNING", "WAITING_OPERATOR", "WAITING_APPROVAL", "WAITING_TIMER"] }, run: { status: "COMPLETED" } },
    });
  }

  async updateRun(id: string, guard: RunGuard, patch: RunPatch): Promise<boolean> {
    const where: Prisma.MigrationRunWhereInput = {
      id,
      ...(guard.bootId ? { ownerId: guard.bootId } : {}),
      ...(guard.statusIn ? { status: { in: [...guard.statusIn] } } : {}),
      ...(guard.sessionId ? { sessionId: guard.sessionId } : {}),
      ...(guard.ponrUnset === true ? { ponrAt: null } : guard.ponrUnset === false ? { ponrAt: { not: null } } : {}),
      ...(guard.orphanOf ? { OR: [{ ownerId: null }, { ownerId: { not: guard.orphanOf } }] } : {}),
    };
    let r: { count: number };
    try {
      r = patch.activeKey !== undefined ? await this.updateWithLocks(id, where, patch) : await this.prisma.migrationRun.updateMany({ where, data: runData(patch) });
    } catch (e) {
      if (isLockClash(e)) throw new ServerHasLiveRunError();
      throw e;
    }
    if (r.count === 1) return true;
    if (guard.bootId) {
      // the lease is still ours but the status moved (a service command like abort won the race): a CAS miss, not a lost lease
      if (guard.statusIn && (await this.prisma.migrationRun.count({ where: { id, ownerId: guard.bootId } })) === 1) return false;
      throw new RunLeaseLostError(id);
    }
    return false;
  }

  /**
   * An update that changes `activeKey` also changes the run's server locks, in ONE transaction (so a crash can neither leave a
   * server locked by a settled run nor unlocked under a live one): `null` releases every lock row, a key re-locks
   * `patch.lockServerIds` (default: the key's own server). A lock clash rolls the whole update back.
   */
  private updateWithLocks(id: string, where: Prisma.MigrationRunWhereInput, patch: RunPatch): Promise<{ count: number }> {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.migrationRun.updateMany({ where, data: runData(patch) });
      if (r.count !== 1) return r;
      await tx.migrationRunServerLock.deleteMany({ where: { runId: id } });
      if (patch.activeKey) {
        const ids = [...new Set(patch.lockServerIds ?? [serverOfKey(patch.activeKey)])];
        if (ids.length) await tx.migrationRunServerLock.createMany({ data: ids.map((serverId) => ({ serverId, runId: id })) });
      }
      return r;
    });
  }

  async updateStep(runId: string, key: StepKey, patch: StepPatch, bootId?: string): Promise<void> {
    if (bootId) {
      const mine = await this.prisma.migrationRun.count({ where: { id: runId, ownerId: bootId } });
      if (mine !== 1) throw new RunLeaseLostError(runId);
    }
    await this.prisma.migrationRunStep.update({ where: { runId_key: { runId, key } }, data: stepData(patch) });
  }

  async updateStepIf(runId: string, key: StepKey, statusIn: readonly StepStatus[], patch: StepPatch): Promise<boolean> {
    const r = await this.prisma.migrationRunStep.updateMany({ where: { runId, key, status: { in: [...statusIn] } }, data: stepData(patch) });
    return r.count === 1;
  }

  async appendEvent(runId: string, e: EventInput, bootId?: string): Promise<number> {
    let seq: number;
    try {
      const r = await this.prisma.migrationRun.update({
        where: { id: runId, ...(bootId ? { ownerId: bootId } : {}) },
        data: { eventSeq: { increment: 1 } },
        select: { eventSeq: true },
      });
      seq = r.eventSeq;
    } catch (err) {
      if (bootId && isNotFound(err)) throw new RunLeaseLostError(runId);
      throw err;
    }
    await this.prisma.migrationRunEvent.create({
      data: { runId, seq, stepKey: e.stepKey, level: e.level, code: e.code, params: json(e.params), actorId: e.actorId },
    });
    return seq;
  }

  events(runId: string, afterSeq: number, limit: number): Promise<EventRow[]> {
    return this.prisma.migrationRunEvent.findMany({ where: { runId, seq: { gt: afterSeq } }, orderBy: { seq: "asc" }, take: limit });
  }

  eventsWithCode(runId: string, code: string, limit: number): Promise<EventRow[]> {
    return this.prisma.migrationRunEvent.findMany({ where: { runId, code }, orderBy: { seq: "asc" }, take: limit });
  }

  async setPonr(runId: string, bootId: string, at: Date, byUserId: string): Promise<Date | "abort"> {
    const r = await this.prisma.migrationRun.updateMany({
      where: { id: runId, ownerId: bootId, ponrAt: null, abortRequested: false, status: { in: ["RUNNING", "WAITING"] } },
      data: { ponrAt: at, ponrByUserId: byUserId },
    });
    if (r.count === 1) return at;
    const row = await this.prisma.migrationRun.findUnique({ where: { id: runId }, select: { ponrAt: true, ownerId: true, abortRequested: true, status: true } });
    if (!row || row.ownerId !== bootId) throw new RunLeaseLostError(runId);
    if (row.ponrAt) return row.ponrAt;
    return "abort";
  }

  async claim(runId: string, bootId: string, now: Date, statusIn: readonly RunStatus[]): Promise<{ claimed: boolean; previousOwner: string | null }> {
    const before = await this.prisma.migrationRun.findUnique({ where: { id: runId }, select: { ownerId: true, status: true } });
    if (!before) return { claimed: false, previousOwner: null };
    const r = await this.prisma.migrationRun.updateMany({
      where: { id: runId, status: { in: [...statusIn] }, ownerId: before.ownerId },
      data: { ownerId: bootId, heartbeatAt: now },
    });
    return { claimed: r.count === 1, previousOwner: before.ownerId };
  }

  async heartbeat(runId: string, bootId: string, now: Date): Promise<boolean> {
    const r = await this.prisma.migrationRun.updateMany({ where: { id: runId, ownerId: bootId }, data: { heartbeatAt: now } });
    return r.count === 1;
  }
}
