import { BadRequestException, ConflictException, ForbiddenException, UnprocessableEntityException } from "@nestjs/common";
import { PitrRestoreService, stageSetFor } from "./pitr-restore.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentCommandTimeoutException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { NotificationsService } from "../notifications/notifications.service";
import { DatabasesService } from "../databases/databases.service";
import { BackupRunnerService } from "./backup-runner.service";

const PW = "s3cr3tPassw0rd";
const T = new Date("2026-11-13T10:30:00Z");
const ENABLED_AT = new Date("2026-11-13T08:00:00Z");
const src = {
  id: "db1", name: "shop", teamId: "t1", serverId: "s1", engine: "POSTGRES", version: "16", image: "postgres:16", environmentId: "env1",
  backupDestinationId: null, credentials: "enc", status: "RUNNING", pitrEnabled: true, pitrEnabledAt: ENABLED_AT,
};
// a replay target is born PROVISIONING (claimed before anything else can touch it)
const target = { ...src, id: "new1", name: "shop (restored)", status: "PROVISIONING", pitrEnabled: false, pitrEnabledAt: null };
const base = { id: "b1", databaseId: "db1", status: "SUCCESS", createdAt: new Date("2026-11-13T09:00:00Z"), completedAt: new Date("2026-11-13T09:02:00Z"), startLsn: "0/2000028", timeline: 1, filename: "t.basebackup.tar.gz", destinationId: null };
const spec = { id: "db1", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "tugra", password: PW, database: "appdb" } };
const SEGS = ["02", "03", "04", "05", "06", "07", "08"].map((s) => `0000000100000000000000${s}`);
// segments shipped 09:00, 09:30, 10:00, 10:30, 11:00, 11:30, 12:00 (LOCAL listing rows, epoch seconds)
const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const shipTimes = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00"].map((t) => epoch(`2026-11-13T${t}:00Z`));
const LIST_OK = SEGS.map((n, i) => `OBJ ${n}.gz 16777216 ${shipTimes[i]}`).join("\n") + "\nTUGRA_WAL_OBJ n=7 more=0 last=x";

type Res = { output: string; exitCode: number } | Error;
type Phase = "list" | "prepare" | "stage" | "seed" | "wait" | "clean";
function phaseOf(script: string): Phase {
  if (script.includes("TUGRA_WAL_OBJ")) return "list";
  if (script.includes("TUGRA_PITR_PREPARE")) return "prepare";
  if (script.includes("TUGRA_WAL_STAGED")) return "stage";
  if (script.includes("TUGRA_PITR_SEED")) return "seed";
  if (script.includes("TUGRA_PITR_RESTORE")) return "wait";
  return "clean";
}

function make(opts: {
  src?: Partial<typeof src>;
  bases?: unknown[];
  online?: boolean;
  results?: Partial<Record<Phase, Res | Res[]>>;
  reprovision?: { status: string; exitCode?: number; output?: string };
  reap?: { cleaned: boolean; reason?: "agent" | "links" };
  inflightRestore?: boolean;
  deny?: string;
  audit?: jest.Mock;
  restoreUpdateMany?: jest.Mock;
  locked?: boolean;
} = {}) {
  const row = { ...src, ...opts.src };
  const bases = opts.bases ?? [base];
  const queues: Partial<Record<Phase, Res[]>> = {};
  for (const [k, v] of Object.entries(opts.results ?? {})) queues[k as Phase] = Array.isArray(v) ? [...v] : [v as Res];
  const sendCommand = jest.fn((_s: string, script: string) => {
    const phase = phaseOf(script);
    const q = queues[phase];
    const next = q && q.length ? q.shift()! : undefined;
    if (next instanceof Error) return Promise.reject(next);
    if (next) return Promise.resolve(next);
    switch (phase) {
      case "list": return Promise.resolve({ exitCode: 0, output: LIST_OK });
      case "prepare": return Promise.resolve({ exitCode: 0, output: "TUGRA_PITR_PREPARE ok uid=999 gid=999" });
      case "stage": {
        const names = [...script.matchAll(/TUGRA_WAL_STAGED (\S+)"/g)].map((m) => m[1]);
        return Promise.resolve({ exitCode: 0, output: [...new Set(names)].map((n) => `TUGRA_WAL_STAGED ${n}`).join("\n") });
      }
      case "seed": return Promise.resolve({ exitCode: 0, output: `TUGRA_PITR_SEED ok pgver=16 start=${SEGS[0]}` });
      case "wait": return Promise.resolve({ exitCode: 0, output: "TUGRA_PITR_RESTORE ok lsn=0/9000028 tl=00000001" });
      default: return Promise.resolve({ exitCode: 0, output: "" });
    }
  });
  const dbUpdate = jest.fn().mockResolvedValue({});
  const dbFindUnique = jest.fn().mockResolvedValue(row);
  const restoreCreate = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "r1", ...args.data }));
  const restoreUpdate = jest.fn().mockResolvedValue({});
  const restoreUpdateMany = opts.restoreUpdateMany ?? jest.fn().mockResolvedValue({ count: 1 });
  const restoreFindFirst = jest.fn().mockResolvedValue(opts.inflightRestore ? { id: "r0" } : null);
  const restoreFindMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    database: { findUnique: dbFindUnique, update: dbUpdate },
    baseBackup: { findMany: jest.fn().mockResolvedValue(bases), findUnique: jest.fn().mockResolvedValue(base) },
    restore: { create: restoreCreate, update: restoreUpdate, updateMany: restoreUpdateMany, findFirst: restoreFindFirst, findMany: restoreFindMany },
  } as unknown as PrismaService;
  const requirePermission = jest.fn((_u: string, _t: string, p: string) => (opts.deny === p ? Promise.reject(new ForbiddenException(p)) : Promise.resolve(undefined)));
  const access = {
    teamRole: jest.fn().mockResolvedValue("OWNER"),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    requirePermission,
    grantResourceAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as TeamAccessService;
  const log = opts.audit ?? jest.fn().mockResolvedValue(undefined);
  const agentWs = { sendCommand, isOnline: jest.fn().mockReturnValue(opts.online ?? true), isCapabilityGranted: jest.fn().mockResolvedValue(true) } as unknown as AgentWsServer;
  const runner = { destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }), toSpec: jest.fn().mockReturnValue(spec) } as unknown as BackupRunnerService;
  const release = jest.fn();
  const rep = opts.reprovision ?? { status: "RUNNING" };
  const reprovision = jest.fn().mockResolvedValue({ row: { ...target, status: rep.status }, exitCode: rep.exitCode ?? 0, output: rep.output ?? "", error: undefined });
  const reap = jest.fn().mockResolvedValue(opts.reap ?? { cleaned: true });
  const databases = {
    createRecoveryTarget: jest.fn().mockResolvedValue(target),
    reprovision,
    reapRecoveryTarget: reap,
    acquireMaintenance: jest.fn().mockReturnValue(release),
    isUnderMaintenance: jest.fn().mockReturnValue(opts.locked ?? false),
  } as unknown as DatabasesService;
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const svc = new PitrRestoreService(prisma, access, { log } as unknown as AuditService, agentWs, runner, databases, { fireForEvent } as unknown as NotificationsService);
  (svc as unknown as { delay: () => Promise<void> }).delay = () => Promise.resolve();
  return { svc, sendCommand, dbUpdate, dbFindUnique, restoreCreate, restoreUpdate, restoreUpdateMany, restoreFindMany, reprovision, reap, release, log, fireForEvent, access, databases };
}
const phases = (sendCommand: jest.Mock) => sendCommand.mock.calls.map((c) => phaseOf(String(c[1])));
const stagedNames = (sendCommand: jest.Mock) =>
  sendCommand.mock.calls.filter((c) => phaseOf(String(c[1])) === "stage").flatMap((c) => [...new Set([...String(c[1]).matchAll(/TUGRA_WAL_STAGED (\S+)"/g)].map((m) => m[1]))]);
const lastRestoreWrite = (m: jest.Mock) => m.mock.calls.at(-1)![0];

describe("stageSetFor", () => {
  const obj = (name: string, t: string) => ({ name, size: 1, mtime: new Date(`2026-11-13T${t}:00Z`) });
  it("stages through the whole BURST shipped at/after the target (+margin), not just the first segment", () => {
    // a backlog flushed at 10:30-10:33 may hold the records for 10:30 in ANY of those segments
    const run = [obj("a", "10:00"), obj("b", "10:30"), obj("c", "10:31"), obj("d", "10:32"), obj("e", "10:33"), obj("f", "11:00"), obj("g", "11:30"), obj("h", "12:00")];
    expect(stageSetFor(run, new Date("2026-11-13T10:30:00Z")).map((o) => o.name)).toEqual(["a", "b", "c", "d", "e", "f", "g"]); // burst b..e, +2 margin
    expect(stageSetFor(run, new Date("2026-11-13T13:00:00Z")).map((o) => o.name)).toEqual(run.map((o) => o.name)); // nothing after T → everything
  });
});

describe("PitrRestoreService.window", () => {
  it("computes earliest = base completion, latest = ship time of the newest contiguous segment; cached for 20s", async () => {
    const { svc, sendCommand } = make();
    const w = await svc.window("u1", "db1");
    expect(w.earliest).toEqual(base.completedAt);
    expect(w.latest!.toISOString()).toBe("2026-11-13T12:00:00.000Z");
    expect(w.bases[0]).toMatchObject({ id: "b1", startLsn: "0/2000028", timeline: 1 });
    expect(w.reason).toBeNull();
    await svc.window("u1", "db1");
    expect(sendCommand).toHaveBeenCalledTimes(1); // cached
  });

  it("reports a reason instead of failing: not enabled / no base / agent offline / unreadable listing", async () => {
    expect((await make({ src: { pitrEnabled: false } }).svc.window("u1", "db1")).reason).toBe("not_enabled");
    expect((await make({ bases: [] }).svc.window("u1", "db1")).reason).toBe("no_base");
    expect((await make({ online: false }).svc.window("u1", "db1")).reason).toBe("agent_offline");
    expect((await make({ results: { list: { exitCode: 1, output: "" } } }).svc.window("u1", "db1")).reason).toBe("list_failed");
    expect((await make({ results: { list: { exitCode: 0, output: "OBJ junk 1 1" } } }).svc.window("u1", "db1")).reason).toBe("list_failed"); // no trailer = unknown
  });

  it("is read-level: a non-member is refused before any agent call", async () => {
    const m = make();
    (m.access.teamRole as jest.Mock).mockResolvedValue(null);
    await expect(m.svc.window("u1", "db1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.sendCommand).not.toHaveBeenCalled();
  });
});

describe("PitrRestoreService.start — replay", () => {
  it("happy path: 202 ids at once; target locked at once; prepare → stage (burst up to T + margin) → seed → start → PROVISIONING re-assert → wait → RUNNING + SUCCESS (guarded); lock + claims released", async () => {
    const { svc, sendCommand, dbUpdate, restoreCreate, restoreUpdateMany, reprovision, reap, release, log, databases } = make();
    const r = await svc.start("u1", "db1", { targetTime: T });
    expect(r).toMatchObject({ restoreId: "r1", databaseId: "new1" });
    expect(databases.acquireMaintenance).toHaveBeenCalledWith("new1");
    expect(restoreCreate.mock.calls[0][0].data).toMatchObject({ databaseId: "db1", sourceDatabaseId: "db1", targetDatabaseId: "new1", targetTime: T, baseBackupId: "b1", kind: "PITR", status: "RUNNING" });
    await r.done;
    expect(phases(sendCommand)).toEqual(["list", "prepare", "stage", "seed", "wait", "clean"]);
    // T=10:30: burst = the 10:30 segment alone (next is 11:00, outside the 5-min burst window), +2 margin → 02..07
    expect(stagedNames(sendCommand)).toEqual(SEGS.slice(0, 6));
    expect(reprovision).toHaveBeenCalledWith(expect.objectContaining({ id: "new1" }), "u1", { pitr: false, recovery: { targetTime: T } });
    expect(dbUpdate.mock.calls.map((c) => c[0].data.status)).toEqual(["PROVISIONING", "RUNNING"]);
    const success = lastRestoreWrite(restoreUpdateMany);
    expect(success.where).toMatchObject({ id: "r1", status: "RUNNING" }); // guarded: never overwrites a finished row
    expect(success.data).toMatchObject({ status: "SUCCESS", exitCode: 0 });
    expect(reap).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.restore", meta: expect.objectContaining({ status: "SUCCESS", lsn: "0/9000028" }) }));
    // the per-source claim is released: a new restore of the same source can start
    await expect(svc.start("u1", "db1", { targetTime: T })).resolves.toMatchObject({ restoreId: "r1" });
  });

  it("refuses BEFORE creating anything: non-Postgres 400, PITR off 409, offline 503, denied permission 403, future / out-of-window 422, DB-known concurrent replay 409", async () => {
    await expect(make({ src: { engine: "MYSQL" } }).svc.start("u1", "db1", { targetTime: T })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ src: { pitrEnabled: false } }).svc.start("u1", "db1", { targetTime: T })).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ online: false }).svc.start("u1", "db1", { targetTime: T })).rejects.toBeInstanceOf(AgentOfflineException);
    const denied = make({ deny: "backups" });
    await expect(denied.svc.start("u1", "db1", { targetTime: T })).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.sendCommand).not.toHaveBeenCalled();
    await expect(make().svc.start("u1", "db1", { targetTime: new Date(Date.now() + 60_000) })).rejects.toBeInstanceOf(UnprocessableEntityException);
    const early = make();
    await expect(early.svc.start("u1", "db1", { targetTime: new Date("2026-11-13T08:30:00Z") })).rejects.toMatchObject({ message: expect.stringMatching(/earliest recoverable/) });
    expect(early.restoreCreate).not.toHaveBeenCalled();
    expect(early.databases.createRecoveryTarget).not.toHaveBeenCalled();
    await expect(make().svc.start("u1", "db1", { targetTime: new Date("2026-11-13T13:00:00Z") })).rejects.toMatchObject({ message: expect.stringMatching(/latest recoverable/) });
    const dup = make({ inflightRestore: true });
    await expect(dup.svc.start("u1", "db1", { targetTime: T })).rejects.toMatchObject({ message: expect.stringMatching(/already running/) });
    expect(dup.databases.createRecoveryTarget).not.toHaveBeenCalled();
  });

  it("a DOUBLE SUBMIT is refused synchronously (per-source claim) even while the first request is still listing WAL", async () => {
    const m = make();
    const first = m.svc.start("u1", "db1", { targetTime: T });
    await expect(m.svc.start("u1", "db1", { targetTime: T })).rejects.toMatchObject({ message: expect.stringMatching(/already running/) });
    const r = await first;
    await r.done;
    expect(m.databases.createRecoveryTarget).toHaveBeenCalledTimes(1);
    expect(m.restoreCreate).toHaveBeenCalledTimes(1);
  });

  it("a throw between creating the target and launching leaves nothing behind (target reaped, lock + claim released)", async () => {
    const m = make();
    (m.access.grantResourceAccess as jest.Mock).mockRejectedValueOnce(new Error("grant down"));
    await expect(m.svc.start("u1", "db1", { targetTime: T })).rejects.toThrow("grant down");
    expect(m.reap).toHaveBeenCalledWith(expect.objectContaining({ id: "new1" }), "u1");
    expect(m.release).toHaveBeenCalled();
    expect(m.restoreCreate).not.toHaveBeenCalled();
    await expect(m.svc.start("u1", "db1", { targetTime: T })).resolves.toBeDefined(); // claim released
  });

  it("a staging failure records FAILED (step + hint + the END of the output), reaps the target, notifies — never RUNNING", async () => {
    const { svc, restoreUpdateMany, reap, dbUpdate, fireForEvent } = make({ results: { stage: { exitCode: 1, output: `TUGRA_WAL_STAGED ${SEGS[0]}\nTUGRA_WAL_STAGE_FAIL ${SEGS[1]}` } } });
    await (await svc.start("u1", "db1", { targetTime: T })).done;
    const w = lastRestoreWrite(restoreUpdateMany);
    expect(w.where).toMatchObject({ status: "RUNNING" });
    expect(w.data.status).toBe("FAILED");
    expect(w.data.errorTail).toMatch(/^stage: A WAL segment could not be downloaded/);
    expect(w.data.errorTail).toContain(`segment ${SEGS[1]}`);
    expect(reap).toHaveBeenCalledWith(expect.objectContaining({ id: "new1" }), "u1");
    expect(dbUpdate.mock.calls.map((c) => c[0].data.status)).not.toContain("RUNNING");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_restore_failed", expect.objectContaining({ dbId: "db1" }));
  });

  it("when the host cleanup could not be confirmed (or apps are linked) the FAILED tail says exactly what to do", async () => {
    const a = make({ reap: { cleaned: false, reason: "agent" }, results: { seed: { exitCode: 20, output: "not empty" } } });
    await (await a.svc.start("u1", "db1", { targetTime: T })).done;
    expect(String(lastRestoreWrite(a.restoreUpdateMany).data.errorTail)).toMatch(/could not be confirmed.*delete the FAILED database/);
    expect(a.log).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ status: "FAILED", reaped: false }) }));
    const b = make({ reap: { cleaned: false, reason: "links" }, results: { seed: { exitCode: 20, output: "not empty" } } });
    await (await b.svc.start("u1", "db1", { targetTime: T })).done;
    expect(String(lastRestoreWrite(b.restoreUpdateMany).data.errorTail)).toMatch(/apps are still linked/);
  });

  it("PROMOTION IS THE COMMIT POINT: a failing post-promote write is retried and never reaps or fails the restored database", async () => {
    const audit = jest.fn((e: { action: string; meta?: { status?: string } }) => (e.action === "database.pitr.restore" && e.meta?.status === "SUCCESS" ? Promise.reject(new Error("audit down")) : Promise.resolve(undefined)));
    const flaky = jest.fn().mockRejectedValueOnce(new Error("blip")).mockRejectedValueOnce(new Error("blip")).mockResolvedValue({ count: 1 });
    const { svc, reap, restoreUpdateMany, dbUpdate } = make({ audit, restoreUpdateMany: flaky });
    await (await svc.start("u1", "db1", { targetTime: T })).done;
    expect(reap).not.toHaveBeenCalled();
    expect(restoreUpdateMany).toHaveBeenCalledTimes(3); // retried until the SUCCESS write landed
    expect(lastRestoreWrite(restoreUpdateMany).data.status).toBe("SUCCESS");
    expect(dbUpdate.mock.calls.at(-1)![0].data.status).toBe("RUNNING");
  });

  it("'still replaying' (32) keeps waiting; TRANSIENT agent errors in the wait loop are retried, not failures; 33 fails with the earlier-time hint", async () => {
    const ok = make({ results: { wait: [{ exitCode: 32, output: "still" }, new AgentOfflineException(), new AgentCommandTimeoutException(), { exitCode: 0, output: "TUGRA_PITR_RESTORE ok lsn=0/9 tl=00000001" }] } });
    await (await ok.svc.start("u1", "db1", { targetTime: T })).done;
    expect(phases(ok.sendCommand).filter((p) => p === "wait")).toHaveLength(4);
    expect(lastRestoreWrite(ok.restoreUpdateMany).data.status).toBe("SUCCESS");
    expect(ok.reap).not.toHaveBeenCalled();
    const bad = make({ results: { wait: { exitCode: 33, output: "ends before" } } });
    await (await bad.svc.start("u1", "db1", { targetTime: T })).done;
    const w = lastRestoreWrite(bad.restoreUpdateMany);
    expect(w.data.status).toBe("FAILED");
    expect(w.data.errorTail).toMatch(/choose an earlier time/);
    expect(bad.reap).toHaveBeenCalled();
  });

  it("transient agent errors while staging are retried (resumable) until the batch lands; a non-transient one fails", async () => {
    const ok = make({ results: { stage: [new AgentOfflineException(), new AgentCommandTimeoutException(), new AgentOfflineException()] } });
    await (await ok.svc.start("u1", "db1", { targetTime: T })).done;
    expect(phases(ok.sendCommand).filter((p) => p === "stage")).toHaveLength(4);
    expect(lastRestoreWrite(ok.restoreUpdateMany).data.status).toBe("SUCCESS");
    const bad = make({ results: { stage: new Error("prisma down") } });
    await (await bad.svc.start("u1", "db1", { targetTime: T })).done;
    expect(lastRestoreWrite(bad.restoreUpdateMany).data.errorTail).toMatch(/^unexpected: An unexpected error/);
    expect(bad.reap).toHaveBeenCalled();
    expect(bad.release).toHaveBeenCalled();
  });

  it("seed refusal (volume not empty, 20) and a recovery container that fails to start both end FAILED + reaped", async () => {
    const seed = make({ results: { seed: { exitCode: 20, output: "tugra: target volume is not empty" } } });
    await (await seed.svc.start("u1", "db1", { targetTime: T })).done;
    expect(lastRestoreWrite(seed.restoreUpdateMany).data.errorTail).toMatch(/^seed: The target data volume already holds data/);
    expect(seed.reap).toHaveBeenCalled();
    const st = make({ reprovision: { status: "FAILED", exitCode: 1, output: "pull failed" } });
    await (await st.svc.start("u1", "db1", { targetTime: T })).done;
    expect(lastRestoreWrite(st.restoreUpdateMany).data.errorTail).toMatch(/^start: The restored container could not be started/);
    expect(st.reap).toHaveBeenCalled();
  });

  it("scrubs the database password from a failure tail and keeps the END of a long output", async () => {
    const long = `${"x".repeat(3000)} FINAL FATAL LINE ${PW}`;
    const { svc, restoreUpdateMany } = make({ results: { prepare: { exitCode: 24, output: long } } });
    await (await svc.start("u1", "db1", { targetTime: T })).done;
    const tail = String(lastRestoreWrite(restoreUpdateMany).data.errorTail);
    expect(tail).not.toContain(PW);
    expect(tail).toMatch(/^prepare: Not enough free disk/);
    expect(tail).toContain("FINAL FATAL LINE");
    expect(tail.length).toBeLessThanOrEqual(2000);
  });

  it("requires databases + backups permissions and grants the creator access to the new database", async () => {
    const { svc, access } = make();
    await (await svc.start("u1", "db1", { targetTime: T })).done;
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "databases");
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "backups");
    expect(access.grantResourceAccess).toHaveBeenCalledWith("u1", "t1", "new1");
  });
});

describe("PitrRestoreService.sweepOrphans — judged by the TARGET, never by age alone", () => {
  const young = { id: "r9", databaseId: "db1", targetDatabaseId: "new9", kind: "PITR", status: "RUNNING", createdAt: new Date(Date.now() - 10 * 60_000) };
  const stale = { ...young, createdAt: new Date(Date.now() - 20 * 3_600_000) };
  function sweepWith(m: ReturnType<typeof make>, rec: unknown, targetRow: Record<string, unknown> | null) {
    m.restoreFindMany.mockResolvedValue([rec]);
    m.dbFindUnique.mockResolvedValue(targetRow);
    return m.svc.sweepOrphans();
  }

  it("a target already RUNNING (promoted, bookkeeping lost) is recorded SUCCESS — never reaped", async () => {
    const m = make();
    await sweepWith(m, young, { ...target, id: "new9", status: "RUNNING" });
    expect(m.reap).not.toHaveBeenCalled();
    expect(lastRestoreWrite(m.restoreUpdateMany)).toMatchObject({ where: { id: "r9", status: "RUNNING" }, data: expect.objectContaining({ status: "SUCCESS" }) });
  });

  it("a PROVISIONING target that the probe shows PROMOTED is finished: RUNNING + staging cleaned + SUCCESS", async () => {
    const m = make();
    await sweepWith(m, young, { ...target, id: "new9" });
    expect(phases(m.sendCommand)).toEqual(["wait", "clean"]);
    expect(m.dbUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "new9" }, data: { status: "RUNNING" } }));
    expect(m.reap).not.toHaveBeenCalled();
    expect(lastRestoreWrite(m.restoreUpdateMany).data.status).toBe("SUCCESS");
  });

  it("a PROVISIONING target still replaying on its own (32) is left for the next sweep; a dead one (31) is reaped + FAILED", async () => {
    const still = make({ results: { wait: { exitCode: 32, output: "still" } } });
    await sweepWith(still, young, { ...target, id: "new9" });
    expect(still.reap).not.toHaveBeenCalled();
    expect(still.restoreUpdateMany).not.toHaveBeenCalled();
    const dead = make({ results: { wait: { exitCode: 31, output: "exited" } } });
    await sweepWith(dead, young, { ...target, id: "new9" });
    expect(dead.reap).toHaveBeenCalledWith(expect.objectContaining({ id: "new9" }), "reconciler");
    expect(lastRestoreWrite(dead.restoreUpdateMany).data).toMatchObject({ status: "FAILED", errorTail: expect.stringMatching(/hub restart/) });
  });

  it("agent offline: a young row waits, a row older than any possible replay is reaped without a verdict", async () => {
    const wait = make({ online: false });
    await sweepWith(wait, young, { ...target, id: "new9" });
    expect(wait.reap).not.toHaveBeenCalled();
    const give = make({ online: false });
    await sweepWith(give, stale, { ...target, id: "new9" });
    expect(give.reap).toHaveBeenCalled();
    expect(lastRestoreWrite(give.restoreUpdateMany).data.status).toBe("FAILED");
  });

  it("skips rows this hub is running or whose target is locked; a missing target is just FAILED", async () => {
    const locked = make({ locked: true });
    await sweepWith(locked, young, { ...target, id: "new9" });
    expect(locked.sendCommand).not.toHaveBeenCalled();
    expect(locked.restoreUpdateMany).not.toHaveBeenCalled();
    const gone = make();
    await sweepWith(gone, young, null);
    expect(gone.reap).not.toHaveBeenCalled();
    expect(lastRestoreWrite(gone.restoreUpdateMany).data).toMatchObject({ status: "FAILED", errorTail: expect.stringMatching(/no longer exists/) });
  });
});
