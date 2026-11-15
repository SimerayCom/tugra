import { VxApplyService, explainApplyExit, provisionWaitMs } from "./vx-apply.service";
import { VxRecoveryService, APPLY_STALE_MS } from "./vx-recovery.service";
import { VxPartRegistry } from "./vx-part-registry";
import { memTasks, memTransfers } from "./testing/vx-memdb";
import { APP_ID, APP_REF, APP_VOL_REF, DB_ID, DB_REF, DB_VOL_REF, GiB, OP, SERVER_ID, TEAM_ID, dbTask } from "./testing/vx-fixtures";
import { MIGRATION_EXIT } from "./vx-scripts";
import type { VxCtx } from "./vx.service";

const ID = "cktransferabcdefghijklmnopq";

function appCtx(over: Partial<VxCtx> = {}): VxCtx {
  return {
    opId: OP, actorId: "user-1", target: { itemRef: APP_VOL_REF, destType: "app-volume", name: "data", mountPath: "/var/www/data", appItemRef: APP_REF },
    targetServerId: SERVER_ID, teamId: TEAM_ID, dockerVolume: `tugra_appv_${APP_ID}_data`, resourceType: "application", resourceId: APP_ID, ownerTaskItemRef: APP_REF,
    server: { id: SERVER_ID, teamId: TEAM_ID, capabilities: ["backup"] }, ...over,
  };
}
const dbCtx = (): VxCtx => appCtx({ target: { itemRef: DB_VOL_REF, destType: "db-data", name: "data", mountPath: "/var/lib/postgresql/data", databaseItemRef: DB_REF, engine: "POSTGRES" }, dockerVolume: `tugra_dbv_${DB_ID}`, resourceType: "database", resourceId: DB_ID, ownerTaskItemRef: DB_REF, credentialsCarried: true });

function make(o: { sendCommand?: (script: string) => Promise<{ exitCode: number; output: string }>; dbStatus?: string; deployments?: number; provisionRejects?: boolean } = {}) {
  const transfers = memTransfers();
  const tasks = memTasks();
  const sent: string[] = [];
  const agentWs = {
    sendCommand: jest.fn(async (_s: string, script: string) => {
      sent.push(script);
      return o.sendCommand ? o.sendCommand(script) : script.includes("TUGRA_VX_APPLY_OK") || script.includes("applying.lock") ? { exitCode: 0, output: "TUGRA_VX_APPLY_OK entries=42\n" } : { exitCode: 0, output: "" };
    }),
  };
  let dbStatus = o.dbStatus ?? "NEW";
  const prisma = {
    migrationVolumeTransfer: transfers,
    bulkTask: tasks,
    bulkOperation: { findUnique: jest.fn().mockResolvedValue({ meta: { vxInventory: {}, actorId: "user-1" }, actorId: "user-1" }) },
    deployment: { count: jest.fn().mockResolvedValue(o.deployments ?? 0) },
    database: { findUnique: jest.fn(async () => ({ status: dbStatus, version: "16", image: "postgres:16-alpine" })) },
    restore: { count: jest.fn().mockResolvedValue(0) },
    backup: { count: jest.fn().mockResolvedValue(0) },
  };
  const databases = {
    provision: jest.fn(async () => {
      if (o.provisionRejects) {
        dbStatus = "FAILED"; // the start failed: the record ends FAILED (it began NEW, as a real import leaves it)
        throw new Error("docker run failed");
      }
      dbStatus = "RUNNING";
      return { status: dbStatus };
    }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const registry = new VxPartRegistry();
  const apply = new VxApplyService(prisma as never, agentWs as never, databases as never, audit as never, registry);
  return { apply, prisma, transfers, tasks, agentWs, databases, audit, sent, registry };
}

async function seed(m: ReturnType<typeof make>, ctx: VxCtx, over: Record<string, unknown> = {}) {
  const row = await m.transfers.create({
    data: { opId: OP, itemRef: ctx.target.itemRef, destType: ctx.target.destType, targetServerId: SERVER_ID, dockerVolume: ctx.dockerVolume, resourceType: ctx.resourceType, resourceId: ctx.resourceId, state: "APPLYING", attempt: 2, partRawBytes: 134217728, partsDone: 3, rawBytesFinal: 300_000_000, entries: 42, runId: "run_x", lastBeatAt: new Date(), ...over },
  });
  await m.tasks.create({ data: { opId: OP, itemRef: `data:${ctx.target.itemRef}`, kind: "data", status: "RUNNING", serverId: SERVER_ID, startedAt: new Date() } });
  return row as never;
}
const settled = async (m: ReturnType<typeof make>, id: string) => {
  for (let i = 0; i < 200 && m.apply.isRunning(id); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("VxApplyService: app volume", () => {
  it("empties the disposable destination, applies with the per-attempt restore id, and ends DONE with a tidy-up", async () => {
    const m = make();
    const t = await seed(m, appCtx());
    m.apply.start(appCtx(), t);
    await settled(m, (t as { id: string }).id);
    const row = m.transfers.rows[0];
    expect(row).toMatchObject({ state: "DONE", phase: null, error: null });
    // order on the target: wipe-dest, apply, cleanup of the staging dir
    expect(m.sent[0]).toContain("find . -mindepth 1 -delete"); // wipe-dest first
    expect(m.sent[1]).toContain(`vx${row.id}2`); // restoreId = vx<transferId><attempt>
    expect(m.sent[1]).toContain("head -c 300000000");
    expect(m.sent[1]).toContain('[ "$E" = "42" ]');
    expect(m.sent.at(-1)).toContain("TUGRA_VX_CLEANUP_DONE");
    const task = m.tasks.rows[0];
    expect(task).toMatchObject({ status: "DONE" });
    expect((task.steps as Array<{ name: string; status: string }>).map((s) => `${s.name}:${s.status}`)).toEqual(["source-verified:DONE", "copying:DONE", "copied:DONE", "applying:DONE", "applied:DONE"]);
    expect(m.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.migration.volume", meta: expect.objectContaining({ status: "SUCCESS" }) }));
  });

  it("a deploy that landed during the copy aborts BEFORE the wipe", async () => {
    const m = make({ deployments: 1 });
    const t = await seed(m, appCtx());
    m.apply.start(appCtx(), t);
    await settled(m, (t as { id: string }).id);
    expect(m.transfers.rows[0]).toMatchObject({ state: "FAILED" });
    expect(m.transfers.rows[0].error).toMatch(/deployed during the copy/);
    expect(m.sent.some((s) => s.includes("-delete"))).toBe(false); // nothing was wiped
  });

  it.each([
    [72, /not a valid archive; the destination volume was not touched/],
    [71, /rolled back/],
    [70, /snapshot volume was kept for manual recovery/],
    [67, /staged parts are missing/],
    [68, /entry count differs/],
    [69, /different major/],
    [137, /unknown outcome/],
  ])("apply exit %i -> FAILED with an honest reason (and never DONE)", async (code, re) => {
    const m = make({ sendCommand: async (s) => (s.includes("applying.lock") ? { exitCode: code, output: "" } : { exitCode: 0, output: "" }) });
    const t = await seed(m, appCtx());
    m.apply.start(appCtx(), t);
    await settled(m, (t as { id: string }).id);
    expect(m.transfers.rows[0].state).toBe("FAILED");
    expect(m.transfers.rows[0].error).toMatch(re);
    expect(m.tasks.rows[0]).toMatchObject({ status: "FAILED" });
    expect(m.sent.at(-1)).not.toContain("TUGRA_VX_CLEANUP_DONE"); // staged parts stay for a retry
  });

  it("exit 0 without the exact marker/entries is NOT success (fail closed)", async () => {
    for (const output of ["", "TUGRA_VX_APPLY_OK entries=41\n", "TUGRA_VX_APPLY_OK entries=42\nTUGRA_VX_APPLY_OK entries=42\n"]) {
      const m = make({ sendCommand: async (s) => (s.includes("applying.lock") ? { exitCode: 0, output } : { exitCode: 0, output: "" }) });
      const t = await seed(m, appCtx());
      m.apply.start(appCtx(), t);
      await settled(m, (t as { id: string }).id);
      expect(m.transfers.rows[0].state).toBe("FAILED");
    }
  });

  it("an unreachable target mid-apply is FAILED with the outcome unknown", async () => {
    const m = make({ sendCommand: async (s) => { if (s.includes("applying.lock")) throw new Error("agent offline"); return { exitCode: 0, output: "" }; } });
    const t = await seed(m, appCtx());
    m.apply.start(appCtx(), t);
    await settled(m, (t as { id: string }).id);
    expect(m.transfers.rows[0].error).toMatch(/outcome is unknown/);
  });

  it("terminal writes are fenced on APPLYING: an abort/reset that won the race is never overwritten", async () => {
    const m = make({ sendCommand: async () => ({ exitCode: 0, output: "TUGRA_VX_APPLY_OK entries=42\n" }) });
    const t = await seed(m, appCtx());
    m.transfers.rows[0].state = "ABORTED";
    m.apply.start(appCtx(), t);
    await settled(m, (t as { id: string }).id);
    expect(m.transfers.rows[0].state).toBe("ABORTED");
  });

  it("starting twice runs one worker", async () => {
    const m = make();
    const t = await seed(m, appCtx());
    m.apply.start(appCtx(), t);
    m.apply.start(appCtx(), t);
    await settled(m, (t as { id: string }).id);
    expect(m.sent.filter((s) => s.includes("applying.lock"))).toHaveLength(1);
  });
});

describe("VxApplyService: Postgres data volume", () => {
  it("applies with the PG_VERSION check, then starts the database through DatabasesService.provision, then DONE (dbData.started)", async () => {
    const m = make();
    const t = await seed(m, dbCtx(), { itemRef: DB_VOL_REF, destType: "db-data", resourceType: "database", resourceId: DB_ID });
    m.apply.start(dbCtx(), t);
    await settled(m, (t as { id: string }).id);
    expect(m.sent.find((s) => s.includes("PG_VERSION"))).toContain('[ "$V" = "16" ]');
    expect(m.sent.find((s) => s.includes("applying.lock"))).toContain("! -path /data/postmaster.pid");
    expect(m.databases.provision).toHaveBeenCalledWith("user-1", DB_ID);
    expect(m.transfers.rows[0].state).toBe("DONE");
    expect(m.tasks.rows[0].result).toMatchObject({ vx: true, databaseItemRef: DB_REF, dbData: { started: true } });
  });

  it("a database that will not start leaves the volume applied: FAILED + a provision-failed marker (retry runs only that step)", async () => {
    const m = make({ provisionRejects: true });
    const t = await seed(m, dbCtx(), { itemRef: DB_VOL_REF, destType: "db-data", resourceType: "database", resourceId: DB_ID });
    m.apply.start(dbCtx(), t);
    await settled(m, (t as { id: string }).id);
    expect(m.transfers.rows[0]).toMatchObject({ state: "FAILED", phase: "provision-failed" });
    expect(m.transfers.rows[0].error).toMatch(/applied but the database did not start/);
    expect(m.tasks.rows[0].result).toMatchObject({ dbData: { started: false } });
    // retry: only the provision step runs again, nothing is re-applied
    const sentBefore = m.sent.length;
    m.transfers.rows[0].state = "APPLYING";
    m.apply.retryProvision(dbCtx(), m.transfers.rows[0] as never);
    await settled(m, m.transfers.rows[0].id as string);
    expect(m.sent.slice(sentBefore).some((s) => s.includes("applying.lock"))).toBe(false);
  });

  it("the credentials/state gates are re-checked before the wipe", async () => {
    const m = make();
    const t = await seed(m, { ...dbCtx(), credentialsCarried: false }, { itemRef: DB_VOL_REF, destType: "db-data", resourceType: "database", resourceId: DB_ID });
    m.apply.start({ ...dbCtx(), credentialsCarried: false }, t);
    await settled(m, (t as { id: string }).id);
    expect(m.transfers.rows[0].state).toBe("FAILED");
    expect(m.transfers.rows[0].error).toMatch(/credentials were not carried/);
    expect(m.sent.some((s) => s.includes("-delete"))).toBe(false);
  });

  it("the post-apply wait scales with the data size and is capped at 30 minutes", () => {
    expect(provisionWaitMs(0)).toBe(60_000);
    expect(provisionWaitMs(200 * 1024 * 1024)).toBe(61_000);
    expect(provisionWaitMs(32 * GiB)).toBeGreaterThan(provisionWaitMs(GiB));
    expect(provisionWaitMs(10_000 * GiB)).toBe(30 * 60_000);
  });
});

describe("explainApplyExit", () => {
  it("has a distinct, honest text for the whole contract and fails closed on anything else", () => {
    const texts = [72, 71, 70, MIGRATION_EXIT.noParts, MIGRATION_EXIT.entryMismatch, MIGRATION_EXIT.pgVersion, null, 3].map(explainApplyExit);
    expect(new Set(texts.slice(0, 6)).size).toBe(6);
    expect(texts[6]).toBe(texts[7]);
    expect(texts[6]).toMatch(/unknown outcome/);
  });
});

describe("VxRecoveryService", () => {
  function rec(applyOver: Record<string, unknown> = {}, probe: unknown = null) {
    const m = make();
    const vx = { resolve: jest.fn().mockResolvedValue(appCtx()) };
    const applySvc = { isRunning: jest.fn().mockReturnValue(false), probeTargetState: jest.fn().mockResolvedValue(probe), resumeAfterApplied: jest.fn(), ...applyOver };
    const prisma = { ...m.prisma, bulkOperation: { findUnique: jest.fn().mockResolvedValue({ actorId: "user-1" }) } };
    const svc = new VxRecoveryService(prisma as never, vx as never, applySvc as never, m.registry);
    return { m, svc, vx, applySvc };
  }
  const old = (ms: number) => new Date(Date.now() - ms);

  it("a COPYING transfer with no beat for the stale window becomes FAILED + resumable (parts kept), task FAILED with the re-run hint", async () => {
    const { m, svc } = rec();
    await seed(m, appCtx(), { state: "COPYING", lastBeatAt: old(10 * 60_000) });
    await svc.sweep();
    expect(m.transfers.rows[0]).toMatchObject({ state: "FAILED", runId: null, partsDone: 3 });
    expect(m.tasks.rows[0]).toMatchObject({ status: "FAILED", output: "migrator stopped reporting; re-run the command to resume" });
    // a fresh beat is left alone
    const f = rec();
    await seed(f.m, appCtx(), { state: "COPYING", lastBeatAt: new Date() });
    await f.svc.sweep();
    expect(f.m.transfers.rows[0].state).toBe("COPYING");
  });

  it("stale APPLYING + target says `applied`: continue the post-apply steps (nothing is re-applied)", async () => {
    const { m, svc, applySvc } = rec({}, { running: false, applied: true, parts: 0, rollbackVolume: false });
    await seed(m, appCtx(), { lastBeatAt: old(APPLY_STALE_MS + 60_000) });
    await svc.sweep();
    expect(applySvc.resumeAfterApplied).toHaveBeenCalledTimes(1);
    expect(m.transfers.rows[0].state).toBe("APPLYING");
  });

  it("stale APPLYING + target says `running`: keep waiting until the apply deadline, then fail", async () => {
    const { m, svc } = rec({}, { running: true, applied: false, parts: 5, rollbackVolume: true });
    await seed(m, appCtx(), { lastBeatAt: old(APPLY_STALE_MS + 60_000), rawBytesFinal: GiB });
    await svc.sweep();
    expect(m.transfers.rows[0].state).toBe("APPLYING");
    m.transfers.rows[0].lastBeatAt = old(25 * 60 * 60_000 + 3 * 60_000); // way past 10 min + 240 s/GiB + 120 s
    await svc.sweep();
    expect(m.transfers.rows[0]).toMatchObject({ state: "FAILED" });
    expect(m.transfers.rows[0].error).toMatch(/did not finish in time/);
  });

  it("stale APPLYING + not running, not applied, parts on the target: FAILED `apply interrupted` (re-run applies the staged parts)", async () => {
    const { m, svc } = rec({}, { running: false, applied: false, parts: 5, rollbackVolume: true });
    await seed(m, appCtx(), { lastBeatAt: old(APPLY_STALE_MS + 60_000) });
    await svc.sweep();
    expect(m.transfers.rows[0]).toMatchObject({ state: "FAILED" });
    expect(m.transfers.rows[0].error).toMatch(/apply interrupted/);
    expect(m.tasks.rows[0].status).toBe("FAILED");
  });

  it("anything it cannot prove is FAILED fail-closed `target state unknown` (probe unusable, offline, nothing staged)", async () => {
    for (const probe of [null, { running: false, applied: false, parts: 0, rollbackVolume: false }]) {
      const { m, svc } = rec({}, probe);
      await seed(m, appCtx(), { lastBeatAt: old(APPLY_STALE_MS + 60_000) });
      await svc.sweep();
      expect(m.transfers.rows[0].state).toBe("FAILED");
      expect(m.transfers.rows[0].error).toMatch(/target state unknown/);
    }
  });

  it("a worker that is alive in this process is never second-guessed; a cancelled import is failed without driving anything", async () => {
    const live = rec({ isRunning: jest.fn().mockReturnValue(true) });
    await seed(live.m, appCtx(), { lastBeatAt: old(APPLY_STALE_MS + 60_000) });
    await live.svc.sweep();
    expect(live.applySvc.probeTargetState).not.toHaveBeenCalled();
    expect(live.m.transfers.rows[0].state).toBe("APPLYING");
    const gone = rec();
    gone.vx.resolve.mockRejectedValue(new Error("operation was cancelled"));
    await seed(gone.m, appCtx(), { lastBeatAt: old(APPLY_STALE_MS + 60_000) });
    await gone.svc.sweep();
    expect(gone.m.transfers.rows[0].state).toBe("FAILED");
    expect(gone.applySvc.probeTargetState).not.toHaveBeenCalled();
  });

  it("is a no-op when the stream is disabled", async () => {
    process.env.MIGRATION_VX_ENABLED = "false";
    const { m, svc } = rec();
    await seed(m, appCtx(), { state: "COPYING", lastBeatAt: old(60 * 60_000) });
    await svc.sweep();
    delete process.env.MIGRATION_VX_ENABLED;
    expect(m.transfers.rows[0].state).toBe("COPYING");
  });
});

void dbTask;
void ID;
