import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { harness, type Harness } from "./testing/vx-harness";
import { DB_DUMP_REF, DB_ID, DB_REF, DB_VOL_REF, GiB, OP, RUN, SERVER_ID, dbTask, appTask, probeOutput } from "./testing/vx-fixtures";
import { VX_409, vxPartRawBytes } from "./vx-constants";
import { DUMP_DEST_PG_LAYOUT_TEXT } from "./vx-dest-gate";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const R = vxPartRawBytes();
const ctxOp = { opId: OP, actorId: "user-1", expiresAt: new Date(Date.now() + 1_800_000) };
const fp = { containerId: "d".repeat(64), startedAt: "2026-11-10T00:00:00Z", finishedAt: "0001-01-01T00:00:00Z", exitCode: 0, mountType: "volume" as const, imageId: "sha256:img1" };
const beginBody = (over: Record<string, unknown> = {}) => ({ runId: RUN, partRawBytes: R, rawTotal: 5 * GiB, fingerprint: fp, ...over });
const finishBody = (parts: number, rawBytes: number, over: Record<string, unknown> = {}) => ({ runId: RUN, parts, rawBytes, entries: 0, fingerprintAfter: { containerId: fp.containerId, startedAt: fp.startedAt, finishedAt: fp.finishedAt, running: true }, ...over });

const measured = (over: Record<string, unknown> = {}) => ({ itemRef: DB_REF, engine: "POSTGRES", state: "measured", dbBytes: 30 * GiB, measuredBy: "catalog", ...over });
const streamMeta = (over: Record<string, unknown> = {}) => ({
  sourceKind: "coolify",
  serverId: SERVER_ID,
  plan: { items: [{ itemRef: DB_REF, kind: "database", proposed: { dataMode: "volume" } }] },
  vxStream: { [DB_REF]: { at: "2026-11-16T00:00:00Z", by: "user-1" } },
  vxDbSizes: { [DB_REF]: measured() },
  ...over,
});
const dumpHarness = (o: Parameters<typeof harness>[0] = {}) => harness({ op: { meta: streamMeta() }, freeKb: 400 * 1024 * 1024, ...o });

function mkPart(raw: number, seed: string) {
  const member = Buffer.from(`member-${seed}-`.repeat(50));
  return { rawLen: raw, rawSha256: sha(`raw-${seed}`), size: member.length, sha256: sha(member), member };
}
const partBody = (p: ReturnType<typeof mkPart>, rawOffset: number, runId = RUN) => ({ runId, rawOffset, rawLen: p.rawLen, rawSha256: p.rawSha256, size: p.size, sha256: p.sha256 });

async function stream(h: Harness, idx: number, p: ReturnType<typeof mkPart>, rawOffset: number): Promise<Record<string, unknown>> {
  const reg = (await h.svc.registerPart(ctxOp, DB_DUMP_REF, idx, partBody(p, rawOffset))) as { srcPath?: string };
  if (!reg.srcPath) throw new Error("no relay path");
  const commit = h.svc.commitPart(ctxOp, DB_DUMP_REF, idx, { runId: RUN });
  await h.put(reg.srcPath, p.member);
  return commit;
}

afterEach(() => {
  delete process.env.MIGRATION_VX_COMMIT_WAIT_MS;
  delete process.env.MIGRATION_VX_DUMP_ENABLED;
  delete process.env.MIGRATION_VX_MAX_DUMP_BYTES;
});

describe("the streamed dump lane: targets", () => {
  it("a database on the lane gets a db-dump row and NO db-data row; the database row is marked volume-mode so its artifact route is closed", async () => {
    const h = dumpHarness();
    const targets = await h.svc.volumeTargetsOf({ ...h.op, tasks: h.op.tasks as never });
    expect(targets.filter((t) => t.destType !== "app-volume").map((t) => [t.itemRef, t.destType])).toEqual([[DB_DUMP_REF, "db-dump"]]);
    const rows = await h.svc.targetRows({ ...h.op, tasks: h.op.tasks as never });
    expect(rows.rows.filter((r) => (r as { itemRef: string }).itemRef !== "volume:srv1:5f3a9c:data")).toEqual([expect.objectContaining({ itemRef: DB_DUMP_REF, kind: "volume", volumeIngest: "stream-dump", dest: { type: "db-dump", name: "dump", mountPath: "" }, databaseItemRef: DB_REF, engine: "POSTGRES" })]);
    expect(rows.volumeRefOfDb.get(DB_REF)).toBe(DB_DUMP_REF);
  });

  it("without the lane the physical plan item still yields its db-data row (unchanged)", async () => {
    const h = harness();
    const targets = await h.svc.volumeTargetsOf({ ...h.op, tasks: h.op.tasks as never });
    expect(targets.some((t) => t.itemRef === DB_VOL_REF && t.destType === "db-data")).toBe(true);
    expect(targets.some((t) => t.destType === "db-dump")).toBe(false);
  });

  it("the kill switch removes the lane's rows (the physical row comes back); the volume stream itself stays", async () => {
    process.env.MIGRATION_VX_DUMP_ENABLED = "false";
    const h = dumpHarness();
    const targets = await h.svc.volumeTargetsOf({ ...h.op, tasks: h.op.tasks as never });
    expect(targets.some((t) => t.destType === "db-dump")).toBe(false);
    expect(h.svc.targetsEnvelope()).toMatchObject({ vxProtocol: 1 });
    expect((h.svc.targetsEnvelope().vx as Record<string, unknown>).dumpMaxBytes).toBeUndefined();
  });

  it("an engine with no dump lane never gets a row, whatever the meta says", async () => {
    const h = dumpHarness({ db: { engine: "REDIS", version: "7" } });
    expect((await h.svc.volumeTargetsOf({ ...h.op, tasks: h.op.tasks as never })).filter((t) => t.destType !== "app-volume")).toEqual([]);
  });

  it("the view of a dump row reports the dump size as its inventory and the destination as `dump`", async () => {
    const h = dumpHarness();
    const r = await h.svc.listVolumes("user-1", OP);
    const v = r.volumes.find((x) => x.itemRef === DB_DUMP_REF)!;
    expect(v).toMatchObject({ destType: "db-dump", destVolume: "dump", state: "NONE", gates: null, inventory: { found: true, rawBytes: 30 * GiB, entries: 0 } });
  });
});

describe("the streamed dump lane: the size report", () => {
  const body = (items: unknown[]) => ({ runId: RUN, items }) as never;
  const item = (over: Record<string, unknown> = {}) => ({ itemRef: DB_REF, engine: "POSTGRES", state: "measured", dbBytes: 123, measuredBy: "catalog", ...over });

  it("merges the report into the op with one atomic jsonb statement and renews the token", async () => {
    const h = harness();
    await expect(h.svc.dbSizes(ctxOp, body([item({ dumpRawBytes: 100, dumpGzBytes: 40, measuredBy: "dump" })]))).resolves.toMatchObject({ stored: 1 });
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = (h.prisma.$executeRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] });
    expect(sql.strings.join("?")).toContain("{vxDbSizes}");
    expect(JSON.parse(sql.values[0] as string)[DB_REF]).toMatchObject({ dbBytes: 123, dumpGzBytes: 40, runId: RUN, at: expect.any(String) });
    expect(h.tokens.extend).toHaveBeenCalledWith(OP);
  });

  it("a database that is not a target of this import, a mismatching engine and a repeated database are 400s", async () => {
    const h = harness();
    await expect(h.svc.dbSizes(ctxOp, body([item({ itemRef: "database:srv1:other" })]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.dbSizes(ctxOp, body([item({ engine: "MARIADB" })]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.dbSizes(ctxOp, body([item(), item()]))).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("is the same uniform 404 as every other vx route when the lane is off", async () => {
    process.env.MIGRATION_VX_DUMP_ENABLED = "off";
    await expect(harness().svc.dbSizes(ctxOp, body([item()]))).rejects.toBeInstanceOf(NotFoundException);
  });

  it("re-authorizes the actor on the TARGET server's team", async () => {
    const h = harness();
    await h.svc.dbSizes(ctxOp, body([item()]));
    expect(h.access.requirePermission).toHaveBeenCalledWith("user-1", expect.any(String), "apps:config");
  });
});

describe("the streamed dump lane: begin", () => {
  it("claims the lease with the dump's own gates and disk verdict (staged parts + the restored database), no physical gates", async () => {
    const h = dumpHarness();
    const r = (await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody())) as Record<string, any>;
    expect(r).toMatchObject({ attempt: 1, state: "COPYING", resumeFromPart: 0, manifest: [], diskVerdict: { ok: true, details: { lane: "dump" } } });
    expect(h.transfers.rows[0]).toMatchObject({ destType: "db-dump", resourceType: "database", resourceId: DB_ID, state: "COPYING", runId: RUN });
    const task = h.tasks.rows.find((t) => t.itemRef === `data:${DB_DUMP_REF}`)!;
    expect(task.result).toMatchObject({ vx: true, databaseItemRef: DB_REF });
  });

  it("refuses when the target cannot hold the staged parts AND the restored database, with the sizes in the reason", async () => {
    const h = dumpHarness({ freeKb: 20 * 1024 * 1024 }); // 20 GiB free on one filesystem
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).rejects.toThrow(/vx-disk-insufficient: the dump needs about/);
    expect(h.transfers.rows).toHaveLength(0);
  });

  it("an unreadable target is `unknown` and refused (fail closed)", async () => {
    const h = dumpHarness({ online: false });
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).rejects.toThrow(/could not verify the free space/);
  });

  it("has no 256 MiB-class cap, only the per-dump sanity limit", async () => {
    const h = dumpHarness({ freeKb: 4000 * 1024 * 1024 });
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ rawTotal: 400 * GiB }))).resolves.toMatchObject({ state: "COPYING" }); // far above the 256 GiB volume limit
    process.env.MIGRATION_VX_MAX_DUMP_BYTES = String(2 * GiB);
    const h2 = dumpHarness();
    await expect(h2.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ rawTotal: 3 * GiB }))).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it("refuses a destination that was started or holds data that is not this migration's (a backup, a foreign restore, a running database nobody here started)", async () => {
    const started = dumpHarness({ db: { status: "RUNNING" } });
    await expect(started.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).rejects.toThrow(VX_409.destDirty);
    const backed = dumpHarness();
    backed.prisma.backup.count.mockResolvedValue(1);
    await expect(backed.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).rejects.toThrow(VX_409.destDirty);
    const foreign = dumpHarness();
    foreign.prisma.restore.count.mockImplementation(async (a: { where: { NOT?: unknown } }) => (a.where.NOT ? 1 : 0));
    await expect(foreign.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).rejects.toThrow(VX_409.destDirty);
  });

  it("a RUNNING database that THIS lane's own restore started is still a valid destination (a retry after a failed restore)", async () => {
    const h = dumpHarness({ db: { status: "RUNNING" } });
    h.prisma.restore.count.mockImplementation(async (a: { where: { NOT?: unknown; createdBy?: unknown } }) => (a.where.createdBy ? 1 : 0));
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).resolves.toMatchObject({ state: "COPYING" });
  });

  it("a PostgreSQL 18+ destination started under the old mount is refused before any byte moves; one with the persistent layout (or never started) is a valid destination", async () => {
    for (const db of [{ version: "18" }, { version: "18.0" }, { version: "latest", image: "postgres:18-alpine" }]) {
      const old = dumpHarness({ db: { ...db, status: "RUNNING", pgParentMount: false } });
      old.prisma.restore.count.mockImplementation(async (a: { where: { NOT?: unknown; createdBy?: unknown } }) => (a.where.createdBy ? 1 : 0));
      await expect(old.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).rejects.toThrow(DUMP_DEST_PG_LAYOUT_TEXT);
      expect(old.transfers.rows).toHaveLength(0);
      await expect(dumpHarness({ db: { ...db, pgParentMount: true } }).svc.begin(ctxOp, DB_DUMP_REF, beginBody())).resolves.toMatchObject({ state: "COPYING" });
      await expect(dumpHarness({ db }).svc.begin(ctxOp, DB_DUMP_REF, beginBody())).resolves.toMatchObject({ state: "COPYING" });
    }
    await expect(dumpHarness({ db: { version: "17" } }).svc.begin(ctxOp, DB_DUMP_REF, beginBody())).resolves.toMatchObject({ state: "COPYING" });
    const mariadb = dumpHarness({ db: { engine: "MARIADB", version: "11", image: "mariadb:11" }, op: { meta: streamMeta({ vxDbSizes: { [DB_REF]: measured({ engine: "MARIADB" }) } }) } });
    await expect(mariadb.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).resolves.toMatchObject({ state: "COPYING" });
  });

  it("the staged parts are budgeted at the raw dump size unless the migrator COUNTED the gzip size (an incompressible dump must not fill the target hours in)", async () => {
    // uncounted 30 GiB catalog size, one filesystem: raw 30 + database 34 GiB = 64 GiB needed (0.6x would have said 52)
    const tight = dumpHarness({ freeKb: 55 * 1024 * 1024 });
    await expect(tight.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ rawTotal: 30 * GiB }))).rejects.toThrow(/vx-disk-insufficient: the dump needs about 30\.0 GiB of staging/);
    const counted = dumpHarness({ freeKb: 55 * 1024 * 1024, op: { meta: streamMeta({ vxDbSizes: { [DB_REF]: measured({ dumpRawBytes: 30 * GiB, dumpGzBytes: 3 * GiB, measuredBy: "dump" }) } }) } });
    await expect(counted.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ rawTotal: 30 * GiB }))).resolves.toMatchObject({ diskVerdict: { ok: true, details: { stagedBytes: Math.ceil(3 * GiB * 1.05) } } });
    // a counted dump that has since grown more than 5% is no longer vouched for by the counted ratio
    const grown = dumpHarness({ freeKb: 55 * 1024 * 1024, op: { meta: streamMeta({ vxDbSizes: { [DB_REF]: measured({ dumpRawBytes: 30 * GiB, dumpGzBytes: 3 * GiB, measuredBy: "dump" }) } }) } });
    await expect(grown.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ rawTotal: 40 * GiB }))).rejects.toThrow(/vx-disk-insufficient/);
  });

  it("the dry-run disk check applies the same budget", async () => {
    const h = dumpHarness({ freeKb: 55 * 1024 * 1024 });
    await expect(h.svc.diskCheck(OP, "user-1", DB_DUMP_REF)).resolves.toMatchObject({ ok: false, details: { stagedBytes: 30 * GiB } });
  });

  it("a live lease of another run is refused; the same run's repeated begin keeps it", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody())).resolves.toMatchObject({ state: "COPYING" });
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ runId: "run_other_9999" }))).rejects.toThrow(VX_409.otherRun);
  });
});

describe("the streamed dump lane: a dump cannot resume from the middle", () => {
  it("parts of an unfinished stream whose migrator is gone are DISCARDED and the dump starts over (no fingerprint complaint, no resume point)", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(R, "a"), 0);
    expect(h.transfers.rows[0].partsDone).toBe(1);
    h.transfers.rows[0].runId = null; // the migrator died: its lease is gone
    h.transfers.rows[0].state = "FAILED";
    const again = (await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ runId: "run_second_0001", fingerprint: { ...fp, startedAt: "2026-11-15T00:00:00Z" } }))) as Record<string, any>;
    expect(again).toMatchObject({ attempt: 2, state: "COPYING", resumeFromPart: 0, manifest: [] });
    expect(h.apply.cleanupTarget).toHaveBeenCalledWith(h.transfers.rows[0].id, SERVER_ID); // the stale staging is gone
    expect(h.parts.rows).toHaveLength(0);
    expect(h.transfers.rows[0]).toMatchObject({ partsDone: 0, rawBytesDone: 0, runId: "run_second_0001" });
    expect(h.tasks.rows.find((t) => t.itemRef === `data:${DB_DUMP_REF}`)).toBeDefined();
  });

  it("an attempt that staged NOTHING (it failed before its first part) does not hold the old source fingerprint: a restarted or recreated source can retry", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    Object.assign(h.transfers.rows[0], { state: "FAILED", runId: null, error: "pg_dump: connection refused", phase: null }); // no part, no finish
    expect(h.transfers.rows[0].partsDone).toBe(0);
    const recreated = { ...fp, containerId: "f".repeat(64), startedAt: "2026-11-16T09:00:00Z", imageId: "sha256:img2" };
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ runId: "run_second_0001", fingerprint: recreated }))).resolves.toMatchObject({ state: "COPYING", attempt: 1 });
    expect(h.transfers.rows[0]).toMatchObject({ runId: "run_second_0001", fingerprint: recreated });
  });

  it("a restart is refused while the target cannot be cleaned (never starts over on top of stale parts)", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(R, "a"), 0);
    h.transfers.rows[0].runId = null;
    h.transfers.rows[0].state = "FAILED";
    h.apply.cleanupTarget.mockResolvedValue(false);
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ runId: "run_second_0001" }))).rejects.toThrow(/could not be cleaned up/);
    expect(h.parts.rows).toHaveLength(1);
  });

  it("a live lease held by another run blocks the restart", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(R, "a"), 0);
    await expect(h.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ runId: "run_other_9999" }))).rejects.toThrow(VX_409.otherRun);
    expect(h.parts.rows).toHaveLength(1);
  });

  it("a transfer whose parts are ALL staged but whose restore failed is re-applied, without dumping again", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(1000, "a"), 0);
    await h.svc.finish(ctxOp, DB_DUMP_REF, finishBody(1, 1000));
    Object.assign(h.transfers.rows[0], { state: "FAILED", runId: null, error: "restore failed", phase: null });
    h.apply.start.mockClear();
    h.apply.probeTargetState.mockResolvedValue({ running: false, applied: false, parts: 1, rollbackVolume: false });
    const again = (await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ runId: "run_second_0001" }))) as Record<string, any>;
    expect(again.state).toBe("APPLYING");
    expect(h.apply.start).toHaveBeenCalledTimes(1);
    expect(h.transfers.rows[0]).toMatchObject({ state: "APPLYING", partsDone: 1, attempt: 1 });
    expect(h.parts.rows).toHaveLength(1); // nothing was thrown away
  });

  it("when the staged parts are gone from the target the failed apply cannot be re-run: the dump starts over", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(1000, "a"), 0);
    await h.svc.finish(ctxOp, DB_DUMP_REF, finishBody(1, 1000));
    Object.assign(h.transfers.rows[0], { state: "FAILED", runId: null, error: "restore failed" });
    h.apply.probeTargetState.mockResolvedValue({ running: false, applied: false, parts: 0, rollbackVolume: false });
    const again = (await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody({ runId: "run_second_0001" }))) as Record<string, any>;
    expect(again).toMatchObject({ state: "COPYING", attempt: 2, resumeFromPart: 0 });
    expect(h.transfers.rows[0].rawBytesFinal).toBeNull();
  });
});

describe("the streamed dump lane: finish, abort and reset", () => {
  it("finish accepts a RUNNING source (a dump reads through the server) when it is the same container run, and starts the apply", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(1000, "a"), 0);
    await expect(h.svc.finish(ctxOp, DB_DUMP_REF, finishBody(1, 1000))).resolves.toMatchObject({ state: "APPLYING" });
    expect(h.apply.start).toHaveBeenCalledTimes(1);
    expect(h.transfers.rows[0]).toMatchObject({ state: "APPLYING", rawBytesFinal: 1000, entries: 0 });
  });

  it("finish refuses a source that restarted during the dump (a different container run), and one that is a different container", async () => {
    for (const after of [{ startedAt: "2026-11-16T00:00:00Z" }, { containerId: "e".repeat(64) }]) {
      const h = dumpHarness();
      await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
      await stream(h, 0, mkPart(1000, "a"), 0);
      await expect(h.svc.finish(ctxOp, DB_DUMP_REF, finishBody(1, 1000, { fingerprintAfter: { ...finishBody(1, 1000).fingerprintAfter, ...after } }))).rejects.toThrow(VX_409.fingerprintChanged);
      expect(h.apply.start).not.toHaveBeenCalled();
    }
  });

  it("finish checks room for the RESTORED DATABASE (the dump is never decoded to disk)", async () => {
    const h = dumpHarness({ op: { meta: streamMeta({ vxDbSizes: { [DB_REF]: measured({ dbBytes: 30 * GiB }) } }) }, probe: undefined, freeKb: 400 * 1024 * 1024 });
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(1000, "a"), 0);
    h.agentWs.sendCommand.mockImplementationOnce(async () => ({ exitCode: 0, output: probeOutput(`tugra_dbv_${DB_ID}`, { stageKb: 400 * 1024 * 1024, dockerKb: 10 * 1024 * 1024, sameDev: false }) }));
    await expect(h.svc.finish(ctxOp, DB_DUMP_REF, finishBody(1, 1000))).rejects.toThrow(/restoring needs about/);
  });

  it("an interrupted migrator frees the target's staging (an unfinished dump can never be resumed)", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(R, "a"), 0);
    await h.svc.abort(ctxOp, DB_DUMP_REF, { runId: RUN });
    expect(h.apply.cleanupTarget).toHaveBeenCalledWith(h.transfers.rows[0].id, SERVER_ID);
    expect(h.transfers.rows[0]).toMatchObject({ state: "FAILED", runId: null });
  });

  it("reset of a dump empties NO volume (there is none): it cleans the staging only", async () => {
    const h = dumpHarness();
    await h.svc.begin(ctxOp, DB_DUMP_REF, beginBody());
    await stream(h, 0, mkPart(R, "a"), 0);
    h.transfers.rows[0].lastBeatAt = new Date(Date.now() - 3_600_000);
    await expect(h.svc.reset(ctxOp, DB_DUMP_REF, { runId: RUN })).resolves.toMatchObject({ state: "PENDING", attempt: 2 });
    expect(h.apply.wipeDest).not.toHaveBeenCalled();
    expect(h.apply.cleanupTarget).toHaveBeenCalled();
  });
});

describe("the streamed dump lane: the disk dry-run and the lane switch", () => {
  it("diskCheck sizes a dump from the migrator's measurement and stores the verdict", async () => {
    const h = dumpHarness();
    await expect(h.svc.diskCheck(OP, "user-1", DB_DUMP_REF)).resolves.toMatchObject({ ok: true, details: { lane: "dump", totalBytes: 30 * GiB } });
    expect(h.prisma.$executeRaw).toHaveBeenCalled(); // storeDisk
  });

  it("diskCheck without any measurement says what to run", async () => {
    const h = dumpHarness({ op: { meta: streamMeta({ vxDbSizes: {} }) } });
    await expect(h.svc.diskCheck(OP, "user-1", DB_DUMP_REF)).rejects.toThrow(/--measure-dbs/);
  });

  it("setStreamMode writes the lane into the op's meta and answers; a take-off removes it", async () => {
    const h = harness();
    await expect(h.svc.setStreamMode("user-1", OP, DB_REF, true)).resolves.toEqual({ itemRef: DB_REF, stream: true });
    const on = (h.prisma.$executeRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] });
    expect(on.strings.join("?")).toContain("{vxStream}");
    expect(JSON.parse(on.values[0] as string)[DB_REF]).toMatchObject({ by: "user-1" });
    h.prisma.$executeRaw.mockClear();
    await h.svc.setStreamMode("user-1", OP, DB_REF, false);
    expect((h.prisma.$executeRaw.mock.calls[0][0] as { strings: string[] }).strings.join("?")).toContain("- ");
  });

  it("setStreamMode refuses an engine with no lane, a database the artifact route already restored, and one a physical copy is underway for", async () => {
    await expect(harness({ db: { engine: "REDIS", version: "7" } }).svc.setStreamMode("user-1", OP, DB_REF, true)).rejects.toBeInstanceOf(ConflictException);
    const restored = harness({ op: { tasks: [appTask(), dbTask(), { id: "t-data", itemRef: `data:${DB_REF}`, kind: "data", status: "DONE", resourceType: null, resourceId: null, result: null, steps: null }] } });
    await expect(restored.svc.setStreamMode("user-1", OP, DB_REF, true)).rejects.toThrow(/already restored by the artifact route/);
    const physical = harness();
    await physical.transfers.create({ data: { opId: OP, itemRef: DB_VOL_REF, destType: "db-data", targetServerId: SERVER_ID, dockerVolume: "v", resourceType: "database", resourceId: DB_ID, partRawBytes: R, state: "COPYING" } });
    await expect(physical.svc.setStreamMode("user-1", OP, DB_REF, true)).rejects.toThrow(/copied as files/);
    await expect(harness().svc.setStreamMode("user-1", OP, "database:srv1:nope", true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("setStreamMode is refused when the lane is switched off", async () => {
    process.env.MIGRATION_VX_DUMP_ENABLED = "0";
    await expect(harness().svc.setStreamMode("user-1", OP, DB_REF, true)).rejects.toBeInstanceOf(ConflictException);
  });
});
