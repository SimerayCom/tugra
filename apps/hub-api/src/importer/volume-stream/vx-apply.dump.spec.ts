import { VxApplyService, explainDumpApplyExit } from "./vx-apply.service";
import { VxPartRegistry } from "./vx-part-registry";
import { memTasks, memTransfers } from "./testing/vx-memdb";
import { DB_DUMP_REF, DB_ID, DB_REF, GiB, OP, SERVER_ID, TEAM_ID } from "./testing/vx-fixtures";
import { dumpRestoreTimeoutMs } from "./vx-dump";
import { DUMP_DEST_PG_LAYOUT_TEXT, dumpDestGate } from "./vx-dest-gate";
import { MIGRATION_EXIT } from "./vx-scripts";
import type { VxCtx } from "./vx.service";

const PASSWORD = "s3cr3t-pw";
const dumpCtx = (): VxCtx => ({
  opId: OP,
  actorId: "user-1",
  target: { itemRef: DB_DUMP_REF, destType: "db-dump", name: "dump", mountPath: "", databaseItemRef: DB_REF, engine: "POSTGRES" },
  targetServerId: SERVER_ID,
  teamId: TEAM_ID,
  dockerVolume: `tugra_dbv_${DB_ID}`,
  resourceType: "database",
  resourceId: DB_ID,
  ownerTaskItemRef: DB_REF,
  server: { id: SERVER_ID, teamId: TEAM_ID, capabilities: ["backup"] },
});

function make(o: { dbStatus?: string; backups?: number; foreignRestores?: number; ourRestores?: number; script?: (s: string) => Promise<{ exitCode: number; output: string }>; provisionRejects?: boolean; decryptFails?: boolean; version?: string; image?: string; pgParentMount?: boolean } = {}) {
  const transfers = memTransfers();
  const tasks = memTasks();
  const sent: Array<{ script: string; timeout: number }> = [];
  const agentWs = {
    sendCommand: jest.fn(async (_s: string, script: string, _cap: string, timeout: number) => {
      sent.push({ script, timeout });
      if (script.includes("TUGRA_VX_CLEANUP_DONE")) return { exitCode: 0, output: "TUGRA_VX_CLEANUP_DONE\n" };
      return o.script ? o.script(script) : { exitCode: 0, output: "TUGRA_VX_APPLY_OK entries=0\n" };
    }),
  };
  let dbStatus = o.dbStatus ?? "NEW";
  const restores: Array<Record<string, any>> = [];
  const prisma = {
    migrationVolumeTransfer: transfers,
    bulkTask: tasks,
    bulkOperation: { findUnique: jest.fn().mockResolvedValue({ meta: {}, actorId: "user-1" }) },
    deployment: { count: jest.fn().mockResolvedValue(0) },
    database: {
      findUnique: jest.fn(async () => ({ id: DB_ID, status: dbStatus, engine: "POSTGRES", version: o.version ?? "16", image: o.image ?? "postgres:16", pgParentMount: o.pgParentMount ?? false, port: 5432, hostPort: null, credentials: "enc" })),
    },
    restore: {
      count: jest.fn(async (a: { where: { NOT?: unknown; createdBy?: unknown } }) => (a.where.NOT ? (o.foreignRestores ?? 0) : a.where.createdBy ? (o.ourRestores ?? restores.filter((r) => String(r.createdBy).startsWith("vx:")).length) : 0)),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        const row = { id: `rs${restores.length + 1}`, ...a.data };
        restores.push(row);
        return row;
      }),
      update: jest.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(restores.find((r) => r.id === a.where.id)!, a.data);
        return {};
      }),
    },
    backup: { count: jest.fn().mockResolvedValue(o.backups ?? 0) },
  };
  const databases = {
    provision: jest.fn(async () => {
      if (o.provisionRejects) {
        dbStatus = "FAILED";
        throw new Error("docker run failed");
      }
      dbStatus = "RUNNING";
      return { status: dbStatus };
    }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const crypto = {
    decrypt: jest.fn(() => {
      if (o.decryptFails) throw new Error("could not decrypt credential blob");
      return JSON.stringify({ username: "app", password: PASSWORD, database: "appdb" });
    }),
  };
  const apply = new VxApplyService(prisma as never, agentWs as never, databases as never, audit as never, new VxPartRegistry(), crypto as never);
  return { apply, prisma, transfers, tasks, sent, restores, databases, audit, opts: o };
}

async function seed(m: ReturnType<typeof make>, over: Record<string, unknown> = {}) {
  const ctx = dumpCtx();
  const row = await m.transfers.create({
    data: { opId: OP, itemRef: ctx.target.itemRef, destType: "db-dump", targetServerId: SERVER_ID, dockerVolume: ctx.dockerVolume, resourceType: "database", resourceId: DB_ID, partRawBytes: 134217728, state: "APPLYING", attempt: 1, partsDone: 3, rawBytesFinal: 30 * GiB, rawBytesDone: 30 * GiB, entries: 0, lastBeatAt: new Date(), ...over },
  });
  await m.tasks.create({ data: { opId: OP, itemRef: `data:${ctx.target.itemRef}`, kind: "data", status: "RUNNING", serverId: SERVER_ID, startedAt: new Date() } });
  return row as never;
}
const settled = async (m: ReturnType<typeof make>, id: string) => {
  for (let i = 0; i < 400 && m.apply.isRunning(id); i++) await new Promise((r) => setTimeout(r, 5));
};
const run = async (m: ReturnType<typeof make>, over: Record<string, unknown> = {}) => {
  const t = await seed(m, over);
  m.apply.start(dumpCtx(), t);
  await settled(m, (t as { id: string }).id);
  return m.transfers.rows[0];
};

describe("VxApplyService: the streamed dump's restore", () => {
  it("starts the database, restores the staged parts under a budget sized from the dump, records the attempt and ends DONE with a tidy-up", async () => {
    const m = make();
    const row = await run(m);
    expect(row).toMatchObject({ state: "DONE", phase: null, error: null });
    expect(m.databases.provision).toHaveBeenCalledWith("user-1", DB_ID);
    const restoreCmd = m.sent.find((s) => s.script.includes("pg_restore"))!;
    expect(restoreCmd.script).toContain(`head -c ${30 * GiB}`);
    expect(restoreCmd.script).toContain("--single-transaction");
    expect(restoreCmd.timeout).toBe(dumpRestoreTimeoutMs(30 * GiB));
    expect(m.restores).toHaveLength(1);
    expect(m.restores[0]).toMatchObject({ databaseId: DB_ID, kind: "IMPORT_URL", createdBy: `vx:${row.id}`, status: "SUCCESS", exitCode: 0 });
    const task = m.tasks.rows.find((t) => t.itemRef === `data:${DB_DUMP_REF}`)!;
    expect(task.status).toBe("DONE");
    expect((task.steps as Array<{ name: string }>).map((s) => s.name)).toEqual(["source-verified", "copying", "copied", "applying", "db-provisioned", "restoring", "applied"]);
    expect(m.sent.at(-1)!.script).toContain("TUGRA_VX_CLEANUP_DONE"); // the staging is removed after success
    expect(m.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.migration.volume", meta: expect.objectContaining({ status: "SUCCESS" }) }));
  });

  it("a database this lane already started (a retry) is NOT provisioned again", async () => {
    const m = make({ dbStatus: "RUNNING", ourRestores: 1 });
    await run(m);
    expect(m.databases.provision).not.toHaveBeenCalled();
    expect(m.transfers.rows[0].state).toBe("DONE");
  });

  it("a failed restore keeps the staged parts, records a FAILED attempt with the password scrubbed, and says what to do", async () => {
    const m = make({ script: async () => ({ exitCode: 1, output: `pg_restore: error: could not connect PGPASSWORD=${PASSWORD} password "${PASSWORD}" failed` }) });
    const row = await run(m);
    expect(row.state).toBe("FAILED");
    expect(row.error).toBe(explainDumpApplyExit(1));
    expect(row.error).toMatch(/re-run the migrator/);
    expect(m.restores[0]).toMatchObject({ status: "FAILED", exitCode: 1 });
    expect(String(m.restores[0].errorTail)).not.toContain(PASSWORD);
    expect(JSON.stringify([row, m.tasks.rows])).not.toContain(PASSWORD);
    expect(m.sent.some((s) => s.script.includes("TUGRA_VX_CLEANUP_DONE"))).toBe(false); // nothing is removed: the next begin re-applies
    expect(row.phase).toBeNull(); // never `provision-failed`: that is the physical copy's retry path
  });

  it("an exit 0 without the marker is NOT success (the outcome is unknown, so it fails closed)", async () => {
    const m = make({ script: async () => ({ exitCode: 0, output: "all good\n" }) });
    expect((await run(m)).state).toBe("FAILED");
  });

  it("a destination that is no longer open (a backup appeared, a foreign restore) is refused BEFORE anything is started or sent", async () => {
    for (const over of [{ backups: 1 }, { foreignRestores: 1 }, { dbStatus: "RUNNING" }]) {
      const m = make(over);
      const row = await run(m);
      expect(row.state).toBe("FAILED");
      expect(row.error).toMatch(/started or holds data not restored by this migration/);
      expect(m.databases.provision).not.toHaveBeenCalled();
      expect(m.sent).toHaveLength(0);
    }
  });

  it("a database that does not start fails the transfer with the parts kept", async () => {
    const m = make({ provisionRejects: true });
    const row = await run(m);
    expect(row.state).toBe("FAILED");
    expect(row.error).toMatch(/did not start/);
    expect(m.sent.some((s) => s.script.includes("pg_restore"))).toBe(false);
  });

  it("a start that failed leaves the lane's own marker, so the destination is still open for the retry (and the retry starts and restores)", async () => {
    const m = make({ provisionRejects: true });
    const first = await run(m);
    expect(first.state).toBe("FAILED");
    expect(m.restores).toHaveLength(1);
    expect(m.restores[0]).toMatchObject({ createdBy: `vx:${first.id}`, status: "FAILED" });
    await expect(m.prisma.database.findUnique()).resolves.toMatchObject({ status: "FAILED" });
    await expect(dumpDestGate(m.prisma as never, DB_ID)).resolves.toEqual({ open: true }); // FAILED + no marker used to read as dirty
    m.opts.provisionRejects = false; // the operator fixed the cause: the next begin re-applies the staged parts
    await m.transfers.updateMany({ where: { id: first.id }, data: { state: "APPLYING" } });
    m.apply.start(dumpCtx(), m.transfers.rows[0] as never);
    await settled(m, String(first.id));
    expect(m.transfers.rows[0].state).toBe("DONE");
    expect(m.databases.provision).toHaveBeenCalledTimes(2);
    expect(m.sent.some((s) => s.script.includes("pg_restore"))).toBe(true);
  });

  it("a database that outlasts the start wait (still PROVISIONING, RUNNING later) is already this lane's own", async () => {
    const m = make({ provisionRejects: true });
    await run(m);
    (m.prisma.database.findUnique as jest.Mock).mockImplementation(async () => ({ id: DB_ID, status: "RUNNING", engine: "POSTGRES", version: "16", image: "postgres:16" }));
    await expect(dumpDestGate(m.prisma as never, DB_ID)).resolves.toEqual({ open: true });
  });

  it("a PostgreSQL 18+ destination that was already started under the old mount is refused before anything runs (its cluster sits in an anonymous volume)", async () => {
    for (const over of [{ version: "18", image: "postgres:18" }, { version: "18.1", image: "postgres:18.1" }, { version: "latest", image: "postgres:19-alpine" }, { version: "", image: "docker.io/library/postgres:18" }, { version: "16", image: "postgres:18" }]) {
      const m = make({ ...over, dbStatus: "RUNNING", ourRestores: 1, pgParentMount: false });
      const row = await run(m);
      expect(row.state).toBe("FAILED");
      expect(row.error).toBe(DUMP_DEST_PG_LAYOUT_TEXT);
      expect(m.sent).toHaveLength(0);
      expect(m.restores).toHaveLength(0);
    }
    const ok = make({ version: "17" });
    expect((await run(ok)).state).toBe("DONE");
  });

  it("a PostgreSQL 18+ destination with the persistent layout (or never started) takes the streamed dump", async () => {
    // a database created with the parent mount, started by an earlier attempt of this lane: a retry restores again
    const retry = make({ version: "18", image: "postgres:18-alpine", dbStatus: "RUNNING", ourRestores: 1, pgParentMount: true });
    const r1 = await run(retry);
    expect(r1.state).toBe("DONE");
    expect(retry.sent.some((s) => s.script.includes("pg_restore"))).toBe(true);
    // a never-started row of an older hub is given the persistent layout when it is provisioned
    const fresh = make({ version: "18", image: "postgres:18-alpine", pgParentMount: false });
    expect((await run(fresh)).state).toBe("DONE");
    expect(fresh.databases.provision).toHaveBeenCalledTimes(1);
  });

  it("an agent that cannot be reached while restoring is an unknown outcome, recorded FAILED", async () => {
    const m = make({ script: async () => Promise.reject(new Error("agent offline")) });
    const row = await run(m);
    expect(row.state).toBe("FAILED");
    expect(row.error).toMatch(/outcome is unknown/);
    expect(m.restores[0].status).toBe("FAILED");
  });

  it("undecryptable credentials fail the transfer WITHOUT echoing anything about them", async () => {
    const m = make({ decryptFails: true });
    const row = await run(m);
    expect(row.state).toBe("FAILED");
    expect(row.error).toBe("could not build the restore");
    expect(m.sent.some((s) => s.script.includes("pg_restore"))).toBe(false);
  });

  it("a transfer with no recorded size is refused", async () => {
    const m = make();
    const row = await run(m, { rawBytesFinal: null });
    expect(row.state).toBe("FAILED");
    expect(m.sent).toHaveLength(0);
  });
});

describe("explainDumpApplyExit", () => {
  it("names the missing parts, and otherwise explains the safe retry (fail closed on anything unknown)", () => {
    expect(explainDumpApplyExit(MIGRATION_EXIT.noParts)).toMatch(/copied again/);
    for (const c of [1, 2, 137, null]) expect(explainDumpApplyExit(c)).toMatch(/staged parts are kept/);
  });
});

describe("VxRecoveryService: a dump whose migrator went silent", () => {
  it("is failed with the honest message (it starts over; it does not resume)", async () => {
    const { VxRecoveryService } = await import("./vx-recovery.service");
    for (const [destType, want] of [["db-dump", /the dump starts over/], ["app-volume", /to resume/]] as const) {
      const m = make();
      await seed(m, { state: "COPYING", destType, runId: "run_x", lastBeatAt: new Date(Date.now() - 3_600_000) });
      const rec = new VxRecoveryService(m.prisma as never, {} as never, m.apply, new VxPartRegistry());
      await rec.sweep();
      expect(m.transfers.rows[0]).toMatchObject({ state: "FAILED", runId: null });
      expect(String(m.transfers.rows[0].error)).toMatch(want);
      expect(String(m.tasks.rows[0].output)).toMatch(want);
    }
  });
});

describe("VxRecoveryService: a dump restore that is still running after a hub restart", () => {
  const minutes = (n: number) => new Date(Date.now() - n * 60_000);
  async function sweepAt(ageMin: number, destType: "db-dump" | "app-volume") {
    const { VxRecoveryService } = await import("./vx-recovery.service");
    const m = make();
    await seed(m, { state: "APPLYING", destType, runId: "run_x", rawBytesFinal: 30 * GiB, lastBeatAt: minutes(ageMin) });
    const applySvc = { isRunning: jest.fn().mockReturnValue(false), probeTargetState: jest.fn().mockResolvedValue({ running: true, applied: false, parts: 5, rollbackVolume: false }), resumeAfterApplied: jest.fn() };
    const vx = { resolve: jest.fn().mockResolvedValue(dumpCtx()) };
    const prisma = { ...m.prisma, bulkOperation: { findUnique: jest.fn().mockResolvedValue({ actorId: "user-1" }) } };
    await new VxRecoveryService(prisma as never, vx as never, applySvc as never, new VxPartRegistry()).sweep();
    return m.transfers.rows[0];
  }

  it("waits for the dump's own restore budget (15 min + 6 min/GiB), not the volume extract's (10 min + 4 min/GiB)", async () => {
    // 30 GiB: the extract deadline is ~132 min, the restore deadline ~195 min
    expect((await sweepAt(150, "db-dump")).state).toBe("APPLYING"); // pg_restore is still within the budget it was given
    expect((await sweepAt(150, "app-volume")).state).toBe("FAILED"); // the same age is past a volume extract's deadline
    expect((await sweepAt(200, "db-dump")).state).toBe("FAILED");
  });
});
