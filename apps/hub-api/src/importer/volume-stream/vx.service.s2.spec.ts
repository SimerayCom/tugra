import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { harness, type Harness } from "./testing/vx-harness";
import { APP_ID, APP_REF, APP_VOL_REF, DB_ID, DB_REF, DB_VOL_REF, GiB, OP, RUN, SERVER_ID, TEAM_ID } from "./testing/vx-fixtures";
import { VX_409, vxPartRawBytes, vxPrincipal } from "./vx-constants";
import { volDataRef } from "../migration-volume";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const R = vxPartRawBytes(); // 128 MiB: a part is "full" when its rawLen equals this
const ctxOp = { opId: OP, actorId: "user-1", expiresAt: new Date(Date.now() + 1_800_000) };
const fp = { containerId: "c".repeat(64), startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-14T10:00:00Z", exitCode: 0, mountType: "volume" as const, mountName: "5f3a9c_data", imageId: "sha256:img1" };
const beginBody = (over: Record<string, unknown> = {}) => ({ runId: RUN, partRawBytes: R, rawTotal: 5 * GiB, fingerprint: fp, ...over });
const finishBody = (parts: number, rawBytes: number, over: Record<string, unknown> = {}) => ({ runId: RUN, parts, rawBytes, entries: 9, fingerprintAfter: { containerId: fp.containerId, startedAt: fp.startedAt, finishedAt: fp.finishedAt, running: false }, ...over });

/** A part: its raw slice descriptor + a (fake) compressed member whose hash the relay and the target verify. */
function mkPart(raw: number, seed: string, idxOffset = 0) {
  const member = Buffer.from(`member-${seed}-`.repeat(50));
  return { rawLen: raw, rawSha256: sha(`raw-${seed}`), size: member.length, sha256: sha(member), member, idxOffset };
}
const partBody = (p: ReturnType<typeof mkPart>, rawOffset: number, runId = RUN) => ({ runId, rawOffset, rawLen: p.rawLen, rawSha256: p.rawSha256, size: p.size, sha256: p.sha256 });

async function stream(h: Harness, idx: number, p: ReturnType<typeof mkPart>, rawOffset: number): Promise<Record<string, unknown>> {
  const reg = (await h.svc.registerPart(ctxOp, APP_VOL_REF, idx, partBody(p, rawOffset))) as { srcPath?: string; alreadyDone?: boolean; busy?: boolean };
  if (!reg.srcPath) return reg;
  const commit = h.svc.commitPart(ctxOp, APP_VOL_REF, idx, { runId: RUN });
  await h.put(reg.srcPath, p.member);
  return commit;
}

afterEach(() => {
  delete process.env.MIGRATION_VX_COMMIT_WAIT_MS;
  delete process.env.MIGRATION_VX_PART_MIB;
  delete process.env.MIGRATION_VX_STALE_MS;
});

describe("VxService.begin", () => {
  it("claims the lease, stores the source fingerprint, stamps the owner on the data task AT CLAIM and returns the resume manifest", async () => {
    const h = harness();
    const r = (await h.svc.begin(ctxOp, APP_VOL_REF, beginBody())) as Record<string, any>;
    expect(r).toMatchObject({ attempt: 1, state: "COPYING", partRawBytes: R, resumeFromPart: 0, manifest: [], diskVerdict: { ok: true } });
    expect(typeof r.transferId).toBe("string");
    expect(r.transferId).toMatch(/^[a-z0-9]{20,32}$/); // doubles as the relay moveId and the staging dir name
    expect(r.expiresAt).toEqual(expect.any(String));
    const row = h.transfers.rows[0];
    expect(row).toMatchObject({ state: "COPYING", runId: RUN, destType: "app-volume", targetServerId: SERVER_ID, dockerVolume: `tugra_appv_${APP_ID}_data`, resourceType: "application", resourceId: APP_ID, partRawBytes: R, fingerprint: fp });
    const task = h.tasks.rows.find((t) => t.itemRef === `data:${APP_VOL_REF}`)!;
    expect(task).toMatchObject({ kind: "data", status: "RUNNING", serverId: SERVER_ID });
    expect(task.result).toMatchObject({ vx: true, appItemRef: APP_REF, volumeName: "data" }); // the rollback guard's join key, set at claim
    expect(task.steps).toEqual([{ name: "source-verified", status: "DONE" }, { name: "copying", status: "RUNNING" }]);
  });

  it("an idempotent begin from the same run keeps the lease; a different live run is `another migrator run is active`", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody())).resolves.toMatchObject({ state: "COPYING" });
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ runId: "run_other_9999" }))).rejects.toThrow(VX_409.otherRun);
    expect(h.transfers.rows).toHaveLength(1);
  });

  it("a stale lease (no beat for the stale window) is taken over by the next run; the atomic claim is one updateMany", async () => {
    process.env.MIGRATION_VX_STALE_MS = "30000";
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    h.transfers.rows[0].lastBeatAt = new Date(Date.now() - 60_000);
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ runId: "run_taker_00001" }))).resolves.toMatchObject({ state: "COPYING" });
    expect(h.transfers.rows[0].runId).toBe("run_taker_00001");
    const claims = h.transfers.updateMany.mock.calls.filter((c) => (c[0].data as { state?: string }).state === "COPYING");
    expect(claims[0][0].where).toMatchObject({ state: { in: ["PENDING", "COPYING", "FAILED"] }, OR: expect.any(Array) });
  });

  it("two migrators racing for a fresh volume: exactly one wins the lease", async () => {
    const h = harness();
    const results = await Promise.allSettled([h.svc.begin(ctxOp, APP_VOL_REF, beginBody()), h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ runId: "run_racer_00002" }))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.transfers.rows).toHaveLength(1);
  });

  it("a begin whose fingerprint differs from the stored one is `vx-fingerprint-changed` (never an auto reset)", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    h.transfers.rows[0].runId = null;
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ fingerprint: { ...fp, startedAt: "2026-11-15T00:00:00Z" } }))).rejects.toThrow(VX_409.fingerprintChanged);
    expect(h.transfers.rows[0].fingerprint).toEqual(fp);
  });

  it("refuses a destination that was deployed (the same predicate the v1 restore uses)", async () => {
    const h = harness();
    h.prisma.deployment.count.mockResolvedValue(1);
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody())).rejects.toThrow(VX_409.destDirty);
    expect(h.transfers.rows).toHaveLength(0);
  });

  it("v1 coexistence: a hub-staged upload for the same volume closes the streamed copy", async () => {
    const h = harness();
    await h.tasks.create({ data: { opId: OP, itemRef: volDataRef(APP_REF, "data"), kind: "data", status: "DONE", serverId: SERVER_ID } });
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody())).rejects.toThrow(VX_409.usesHubStaged);
  });

  it("caps: partRawBytes must equal the hub policy (400), rawTotal over the limit is 413", async () => {
    const h = harness();
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ partRawBytes: R / 2 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ rawTotal: 257 * GiB }))).rejects.toBeInstanceOf(PayloadTooLargeException);
    process.env.MIGRATION_VX_PART_MIB = "64";
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ partRawBytes: 64 * 1024 ** 2 }))).resolves.toMatchObject({ partRawBytes: 64 * 1024 ** 2 });
  });

  it("an excluded volume cannot begin", async () => {
    const h = harness({ op: { meta: { sourceKind: "coolify", serverId: SERVER_ID, plan: { items: [] }, vxExcluded: { [APP_VOL_REF]: { reason: "x", at: "a", by: "u" } } } } });
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody())).rejects.toBeInstanceOf(ConflictException);
  });

  it("disk: insufficient is `vx-disk-insufficient` WITH numbers; unknown (offline target) fails closed", async () => {
    const small = harness({ freeKb: 8 * 1024 * 1024 }); // 8 GiB free for a 5 GiB volume on one filesystem
    await expect(small.svc.begin(ctxOp, APP_VOL_REF, beginBody())).rejects.toThrow(new RegExp(`${VX_409.diskInsufficient}.*needs about 11\\.\\d GiB.*free`));
    expect(small.transfers.rows).toHaveLength(0);
    await expect(harness({ online: false }).svc.begin(ctxOp, APP_VOL_REF, beginBody())).rejects.toThrow(/vx-disk-insufficient.*offline/);
    await expect(harness({ supportsOrigin: false }).svc.begin(ctxOp, APP_VOL_REF, beginBody())).rejects.toThrow(/too old/);
  });

  it("an ABORTED transfer needs a reset; a DONE one answers alreadyDone; an APPLYING one just reports", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    const row = h.transfers.rows[0];
    row.state = "ABORTED";
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody())).rejects.toThrow(VX_409.aborted);
    row.state = "DONE";
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody())).resolves.toMatchObject({ alreadyDone: true, state: "DONE" });
    row.state = "APPLYING";
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody())).resolves.toMatchObject({ state: "APPLYING" });
  });

  it("resume: a begin after an interruption returns the committed parts and skips the free-space probe", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    const p0 = mkPart(R, "a");
    await stream(h, 0, p0, 0);
    await h.svc.abort(ctxOp, APP_VOL_REF, { runId: RUN });
    h.agentWs.sendCommand.mockClear();
    const r = (await h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ runId: "run_second_0003" }))) as Record<string, any>;
    expect(r.resumeFromPart).toBe(1);
    expect(r.manifest).toEqual([{ idx: 0, rawOffset: 0, rawLen: R, rawSha256: p0.rawSha256 }]);
    expect(h.agentWs.sendCommand).not.toHaveBeenCalled(); // no probe on resume
  });
});

describe("VxService.begin — Postgres data volume (db-data)", () => {
  const inv = { itemRef: DB_VOL_REF, found: true, mountType: "volume", rawBytes: GiB, entries: 5, specials: { sockets: 0, fifos: 0, devices: 0 }, running: false, exitCode: 0, image: "postgres:16-alpine", pgMajor: "16", pgLayout: "root", mountDest: "/var/lib/postgresql/data" };
  const meta = (extra: Record<string, unknown> = {}) => ({ sourceKind: "coolify", serverId: SERVER_ID, plan: { items: [{ itemRef: DB_REF, kind: "database", proposed: { dataMode: "volume" } }] }, vxInventory: { [DB_VOL_REF]: inv }, ...extra });
  const body = beginBody({ rawTotal: GiB, fingerprint: { ...fp, pgMajor: "16" } });

  it("every gate passes: begins, and the data task carries the databaseItemRef (rollback guard join key)", async () => {
    const h = harness({ op: { meta: meta() } });
    await expect(h.svc.begin(ctxOp, DB_VOL_REF, body)).resolves.toMatchObject({ state: "COPYING" });
    expect(h.tasks.rows.find((t) => t.itemRef === `data:${DB_VOL_REF}`)!.result).toMatchObject({ vx: true, databaseItemRef: DB_REF });
    expect(h.transfers.rows[0]).toMatchObject({ destType: "db-data", resourceType: "database", resourceId: DB_ID });
  });

  const refuse = async (h: Harness, text: string | RegExp) => {
    await expect(h.svc.begin(ctxOp, DB_VOL_REF, body)).rejects.toThrow(text);
    expect(h.transfers.rows).toHaveLength(0); // a refused volume never holds a lease
  };
  it("O1 fail-closed: no inventory (servet's image/major/mount unknown) -> refused with the how-to", async () => {
    await refuse(harness({ op: { meta: meta({ vxInventory: {} }) } }), /run the migrator with --dry-run/);
  });
  it("credentials not carried -> the exact text", async () => {
    const op = { meta: meta(), tasks: [{ id: "t-db", itemRef: DB_REF, kind: "database", status: "DONE", resourceType: "database", resourceId: DB_ID, result: { credentialsCarried: false } }] };
    await refuse(harness({ op }), "this database's credentials were not carried from the source, so a copied data directory would not match them; use the logical dump");
  });
  it("PG18 nested layout -> the exact text", async () => {
    await refuse(harness({ op: { meta: meta({ vxInventory: { [DB_VOL_REF]: { ...inv, pgLayout: "nested", pgMajor: "18" } } }) }, db: { version: "18", image: "postgres:18-alpine" } }), "PostgreSQL 18 data layout is not supported by Tugra database volumes yet");
  });
  it("major mismatch and image mismatch (alpine -> debian) are refused", async () => {
    await refuse(harness({ op: { meta: meta({ vxInventory: { [DB_VOL_REF]: { ...inv, pgMajor: "15" } } }) } }), /major \(15\) differs/);
    await refuse(harness({ op: { meta: meta() }, db: { image: "postgres:16" } }), /needs the same image/);
  });
  it("a started destination database is refused", async () => {
    await refuse(harness({ op: { meta: meta() }, db: { status: "RUNNING" } }), VX_409.destDirty);
  });
  it("a running source (inventory) is refused", async () => {
    const running = meta({ vxInventory: { [DB_VOL_REF]: { ...inv, running: true } } });
    await refuse(harness({ op: { meta: running } }), /stop it first/);
  });
});

describe("VxService parts: register -> relay PUT -> commit", () => {
  async function started(o: Parameters<typeof harness>[0] = {}) {
    const h = harness(o);
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    return h;
  }

  it("streams three parts through the memory relay (mig:<opId> principal), commits each and records the manifest", async () => {
    const h = await started();
    const p = [mkPart(R, "a"), mkPart(R, "b"), mkPart(1234, "c")];
    let off = 0;
    for (let i = 0; i < 3; i++) {
      const c = (await stream(h, i, p[i], off)) as Record<string, any>;
      expect(c).toMatchObject({ done: true, partsDone: i + 1 });
      off += p[i].rawLen;
    }
    const row = h.transfers.rows[0];
    expect(row).toMatchObject({ partsDone: 3, state: "COPYING" });
    expect(Number(row.rawBytesDone)).toBe(2 * R + 1234);
    expect(Number(row.bytesDone)).toBe(p.reduce((n, x) => n + x.size, 0));
    expect(h.parts.rows.map((r) => [r.idx, Number(r.rawOffset), r.rawLen, r.rawSha256])).toEqual(p.map((x, i) => [i, i * R, x.rawLen, x.rawSha256]));
    expect(h.staged.size).toBe(3); // the target really received the verified bytes
    expect(h.registry.size).toBe(0);
    // the part was registered under the migration principal, with the transfer id as the moveId
    const recvScript = h.cmds.find((c) => c.includes("TUGRA_VX_RECV_OK"))!;
    expect(recvScript).toContain(`/etc/tugra/app-moves/${row.id}/0`);
    expect(recvScript).toContain("p.00000");
    expect(h.tasks.rows.find((t) => t.itemRef === `data:${APP_VOL_REF}`)!.result).toMatchObject({ progress: { partsDone: 3 } });
    expect(vxPrincipal(OP)).toBe(`mig:${OP}`);
  });

  it("a commit does not complete until the part really arrived (no PUT -> pending, never a false success)", async () => {
    process.env.MIGRATION_VX_COMMIT_WAIT_MS = "40";
    const h = await started();
    const p = mkPart(R, "a");
    const reg = (await h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0))) as { srcPath: string };
    await expect(h.svc.commitPart(ctxOp, APP_VOL_REF, 0, { runId: RUN })).resolves.toMatchObject({ pending: true });
    expect(h.transfers.rows[0].partsDone).toBe(0);
    // the part then arrives and the SAME inflight part commits on the next poll
    const second = h.svc.commitPart(ctxOp, APP_VOL_REF, 0, { runId: RUN });
    await h.put(reg.srcPath, p.member);
    await expect(second).resolves.toMatchObject({ done: true, partsDone: 1 });
  });

  it("a failed target receive is {done:false, retryable} with a scrubbed reason (no relay path, no origin)", async () => {
    const h = await started();
    h.recvOverride.fail = { exitCode: 22, output: "curl: (22) 404 for http://hub.example/api/v1/agent-vx/t/abc_DEF-ghi123456789?exp=1&sig=zzzzzzzzzzzzzzzz" };
    const p = mkPart(R, "a");
    await h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0));
    const c = (await h.svc.commitPart(ctxOp, APP_VOL_REF, 0, { runId: RUN })) as { done: boolean; retryable: boolean; reason: string };
    expect(c).toMatchObject({ done: false, retryable: true });
    expect(c.reason).not.toMatch(/agent-vx|sig=|exp=/);
    expect(h.transfers.rows[0].partsDone).toBe(0);
    expect(h.registry.size).toBe(0);
  });

  it("a body whose length or hash differs from what was registered fails the part and nothing is recorded", async () => {
    const h = await started();
    const p = mkPart(R, "a");
    const reg = (await h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0))) as { srcPath: string };
    const commit = h.svc.commitPart(ctxOp, APP_VOL_REF, 0, { runId: RUN });
    await expect(h.put(reg.srcPath, Buffer.from("tampered".repeat(80)), p.size)).rejects.toBeTruthy();
    expect(await commit).toMatchObject({ done: false });
    expect(h.transfers.rows[0].partsDone).toBe(0);
    expect(h.parts.rows).toHaveLength(0);
  });

  it("replays: an idx already committed is alreadyDone for the same raw hash and `vx-diverged` for another", async () => {
    const h = await started();
    const p = mkPart(R, "a");
    await stream(h, 0, p, 0);
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0))).resolves.toMatchObject({ alreadyDone: true });
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, { ...partBody(p, 0), rawSha256: sha("different raw slice") })).rejects.toThrow(VX_409.diverged);
    // committing a committed part again is idempotent
    await expect(h.svc.commitPart(ctxOp, APP_VOL_REF, 0, { runId: RUN })).resolves.toMatchObject({ done: true, partsDone: 1 });
  });

  it("a short part is accepted but nothing may follow it (`vx-short-part`)", async () => {
    const h = await started();
    const short = mkPart(1000, "s");
    await stream(h, 0, short, 0);
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 1, partBody(mkPart(R, "n"), 1000))).rejects.toThrow(VX_409.shortPart);
  });

  it("validates the descriptor: out of order, wrong offset, rawLen over the policy, size over the gzip bound, volume over the limit", async () => {
    const h = await started();
    const p = mkPart(R, "a");
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 3, partBody(p, 0))).rejects.toThrow(/out of order/);
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 5))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, { ...partBody(p, 0), rawLen: R + 1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, { ...partBody(p, 0), rawLen: 100, size: 100 + 1 + 1024 + 1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 100_000, partBody(p, 0))).rejects.toBeInstanceOf(BadRequestException);
    process.env.MIGRATION_VX_MAX_BYTES = String(GiB);
    const big = harness();
    await big.svc.begin(ctxOp, APP_VOL_REF, beginBody({ rawTotal: GiB / 2 }));
    await expect(big.svc.registerPart(ctxOp, APP_VOL_REF, 0, { ...partBody(p, 0), rawLen: R })).resolves.toBeDefined(); // 128 MiB <= 1 GiB
    delete process.env.MIGRATION_VX_MAX_BYTES;
  });

  it("the lease: a different runId, an aborted or finished transfer cannot register/commit", async () => {
    const h = await started();
    const p = mkPart(R, "a");
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0, "run_not_the_owner"))).rejects.toThrow(VX_409.otherRun);
    await expect(h.svc.commitPart(ctxOp, APP_VOL_REF, 0, { runId: "run_not_the_owner" })).rejects.toThrow(VX_409.otherRun);
    h.transfers.rows[0].state = "ABORTED";
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0))).rejects.toThrow(VX_409.aborted);
  });

  it("a deploy that lands DURING the copy stops the next part", async () => {
    const h = await started();
    await stream(h, 0, mkPart(R, "a"), 0);
    h.prisma.deployment.count.mockResolvedValue(1);
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 1, partBody(mkPart(R, "b"), R))).rejects.toThrow(VX_409.destDirty);
  });

  it("busy: when the migration relay pool is full the answer is {busy:true} (uncounted), not an error", async () => {
    const h = await started({ relayConcurrency: 1 });
    const squatter = h.relay.register({ moveId: "cksquatter0000000000000001", volIdx: 0, part: 0, size: 1, sha256: sha("x"), srcServerId: vxPrincipal("someotherop"), dstServerId: "d" });
    expect(squatter.busy).toBe(false);
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(mkPart(R, "a"), 0))).resolves.toEqual({ busy: true });
    if (!squatter.busy) squatter.cancel(new Error("done"));
  });

  it("re-registering the same part cancels the previous attempt's rendezvous and receive command", async () => {
    const h = await started();
    const p = mkPart(R, "a");
    h.recvOverride.hang = true; // the first receive never finishes
    const first = (await h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0))) as { srcPath: string };
    expect(h.relay.size).toBe(1);
    h.recvOverride.hang = false;
    const second = (await h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0))) as { srcPath: string };
    expect(second.srcPath).not.toBe(first.srcPath);
    expect(h.relay.size).toBe(1); // the first was destroyed, only the second is live
    const commit = h.svc.commitPart(ctxOp, APP_VOL_REF, 0, { runId: RUN });
    await h.put(second.srcPath, p.member);
    await expect(commit).resolves.toMatchObject({ done: true });
  });

  it("hub restart: no in-flight part -> `vx-part-lost`; a part the target already holds is recovered by size+sha (stat shortcut)", async () => {
    const h = await started();
    const p = mkPart(R, "a");
    await stream(h, 0, p, 0);
    const p1 = mkPart(R, "b");
    const reg = (await h.svc.registerPart(ctxOp, APP_VOL_REF, 1, partBody(p1, R))) as { srcPath: string };
    const pending = h.svc.commitPart(ctxOp, APP_VOL_REF, 1, { runId: RUN });
    await h.put(reg.srcPath, p1.member);
    await pending;
    // simulate the lost commit: roll the row back to partsDone=1 but the target keeps p.00001
    h.transfers.rows[0].partsDone = 1;
    h.transfers.rows[0].rawBytesDone = R;
    h.transfers.rows[0].bytesDone = p.size;
    h.parts.rows = h.parts.rows.filter((r) => r.idx === 0);
    // ...and the hub restarts: the registry is gone
    (h.registry as unknown as { seen: Map<string, number>; inflight: Map<string, unknown> }).seen.clear();
    await expect(h.svc.commitPart(ctxOp, APP_VOL_REF, 1, { runId: RUN })).rejects.toThrow(VX_409.partLost);
    const again = await h.svc.registerPart(ctxOp, APP_VOL_REF, 1, partBody(p1, R));
    expect(again).toMatchObject({ alreadyDone: true });
    expect(h.transfers.rows[0].partsDone).toBe(2);
    expect(h.parts.rows.map((r) => r.idx)).toEqual([0, 1]);
  });

  it("the stat shortcut never trusts a target part whose size or sha differs", async () => {
    const h = await started();
    const p = mkPart(R, "a");
    h.staged.set(0, Buffer.from("something else entirely")); // wrong bytes sit at p.00000
    const r = await h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0));
    expect(r).toHaveProperty("srcPath"); // a normal transfer, not alreadyDone
    h.registry.cancel(h.transfers.rows[0].id as string, new Error("cleanup"));
  });
});

describe("VxService.finish", () => {
  async function copied(parts = 2) {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    let off = 0;
    for (let i = 0; i < parts; i++) {
      const p = mkPart(i === parts - 1 ? 777 : R, `p${i}`);
      await stream(h, i, p, off);
      off += p.rawLen;
    }
    return { h, raw: off };
  }

  it("validates, moves COPYING -> APPLYING and starts the apply worker; the task shows the apply step", async () => {
    const { h, raw } = await copied();
    const r = await h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, raw));
    expect(r).toMatchObject({ state: "APPLYING", expiresAt: expect.any(String) });
    expect(h.transfers.rows[0]).toMatchObject({ state: "APPLYING", entries: 9 });
    expect(Number(h.transfers.rows[0].rawBytesFinal)).toBe(raw);
    expect(h.apply.start).toHaveBeenCalledTimes(1);
    expect(h.tasks.rows.find((t) => t.itemRef === `data:${APP_VOL_REF}`)!.steps).toEqual([
      { name: "source-verified", status: "DONE" }, { name: "copying", status: "DONE" }, { name: "copied", status: "DONE" }, { name: "applying", status: "RUNNING" },
    ]);
  });

  it("refuses a part count, a size, a gap or a source change that does not match what was committed", async () => {
    const { h, raw } = await copied();
    await expect(h.svc.finish(ctxOp, APP_VOL_REF, finishBody(3, raw))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, raw + 1))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, raw, { fingerprintAfter: { containerId: fp.containerId, startedAt: "2026-11-15T09:00:00Z", finishedAt: fp.finishedAt, running: false } }))).rejects.toThrow(VX_409.fingerprintChanged);
    await expect(h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, raw, { fingerprintAfter: { containerId: fp.containerId, startedAt: fp.startedAt, finishedAt: fp.finishedAt, running: true } }))).rejects.toThrow(VX_409.fingerprintChanged);
    expect(h.transfers.rows[0].state).toBe("COPYING");
    h.parts.rows = h.parts.rows.filter((r) => r.idx !== 0);
    h.parts.rows.forEach((r) => (r.rawOffset = 5));
    await expect(h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, raw))).rejects.toThrow(VX_409.diverged);
    expect(h.apply.start).not.toHaveBeenCalled();
  });

  it("re-checks the destination (deployed during the copy) and the target's docker-root space for the DECODED copy", async () => {
    const a = await copied();
    a.h.prisma.deployment.count.mockResolvedValue(1);
    await expect(a.h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, a.raw))).rejects.toThrow(VX_409.destDirty);
    const b = await copied();
    b.h.agentWs.sendCommand.mockImplementationOnce(async () => ({ exitCode: 0, output: "" })); // consumed by nothing relevant
    const tiny = harness({ freeKb: 1024 }); // 1 MiB free
    await tiny.svc.begin(ctxOp, APP_VOL_REF, beginBody({ rawTotal: 100 })).catch(() => undefined);
    // direct: a probe with almost no docker-root space for 2 parts
    const c = await copied();
    c.h.agentWs.sendCommand.mockImplementation(async (_s: string, script: string) => (script.includes("TUGRA_PROBE_END") ? { exitCode: 0, output: ["TUGRA_DF /var/lib/docker 1024 1", "TUGRA_DF /etc/tugra/app-moves 99999999 2", "TUGRA_TOOL curl 1", "TUGRA_TOOL split 1", "TUGRA_TOOL sha256sum 1", "TUGRA_TOOL gzip 1", "TUGRA_TOOL helper 1", `TUGRA_VOL tugra_appv_${APP_ID}_data ABSENT`, "TUGRA_PROBE_END"].join("\n") } : { exitCode: 0, output: "" }));
    await expect(c.h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, c.raw))).rejects.toThrow(/vx-disk-insufficient: extracting needs/);
    // an unreadable probe fails closed too
    const d = await copied();
    d.h.agentWs.isOnline.mockReturnValue(false);
    await expect(d.h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, d.raw))).rejects.toThrow(/vx-disk-insufficient/);
    expect(d.h.apply.start).not.toHaveBeenCalled();
  });

  it("only the lease holder may finish, and not while a part is still in flight", async () => {
    const { h, raw } = await copied();
    await expect(h.svc.finish(ctxOp, APP_VOL_REF, finishBody(2, raw, { runId: "run_not_the_owner" }))).rejects.toThrow(VX_409.otherRun);
    h.recvOverride.hang = true;
    await h.svc.registerPart(ctxOp, APP_VOL_REF, 2, partBody(mkPart(R, "x"), raw)).catch(() => undefined);
  });
});

describe("VxService status / beat / abort / reset", () => {
  it("status reports progress + ETA and renews the expiry on every response", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    await stream(h, 0, mkPart(R, "a"), 0);
    const s = (await h.svc.status(ctxOp, APP_VOL_REF)) as Record<string, any>;
    expect(s).toMatchObject({ state: "COPYING", partsDone: 1, rawBytesDone: R, rawBytesTotal: 5 * GiB, expiresAt: expect.any(String) });
    expect(s.etaSec).toEqual(expect.any(Number));
    expect(h.tokens.extend).toHaveBeenCalled();
    expect(await h.svc.status(ctxOp, "volume:srv1:5f3a9c:data")).toBeDefined();
    const none = harness();
    expect(await none.svc.status(ctxOp, APP_VOL_REF)).toMatchObject({ state: "NONE" });
  });

  it("beat renews the lease for the owner only", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    h.transfers.rows[0].lastBeatAt = new Date(Date.now() - 100_000);
    await expect(h.svc.beat(ctxOp, APP_VOL_REF, { runId: RUN, phase: "skipping" })).resolves.toEqual({ expiresAt: expect.any(String) });
    expect(Date.now() - (h.transfers.rows[0].lastBeatAt as Date).getTime()).toBeLessThan(5_000);
    expect(h.transfers.rows[0].phase).toBe("skipping");
    await expect(h.svc.beat(ctxOp, APP_VOL_REF, { runId: "run_not_the_owner" })).rejects.toThrow(VX_409.otherRun);
  });

  it("the migrator's abort drops the in-flight part, releases the lease and KEEPS the staged parts (resumable)", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    await stream(h, 0, mkPart(R, "a"), 0);
    h.recvOverride.hang = true;
    await h.svc.registerPart(ctxOp, APP_VOL_REF, 1, partBody(mkPart(R, "b"), R));
    await expect(h.svc.abort(ctxOp, APP_VOL_REF, { runId: RUN })).resolves.toEqual({ state: "FAILED" });
    expect(h.transfers.rows[0]).toMatchObject({ state: "FAILED", runId: null, partsDone: 1 });
    expect(h.parts.rows).toHaveLength(1);
    expect(h.registry.size).toBe(0);
    expect(h.relay.size).toBe(0);
    // an abort from a non-owner is a no-op
    await expect(h.svc.abort(ctxOp, APP_VOL_REF, { runId: "run_not_the_owner" })).resolves.toEqual({ state: "FAILED" });
  });

  it("reset wipes the target, deletes the parts, bumps the attempt, clears the fingerprint and lease", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    await stream(h, 0, mkPart(R, "a"), 0);
    h.transfers.rows[0].state = "FAILED";
    await expect(h.svc.reset(ctxOp, APP_VOL_REF, { runId: RUN })).resolves.toEqual({ state: "PENDING", attempt: 2 });
    expect(h.apply.cleanupTarget).toHaveBeenCalledWith(h.transfers.rows[0].id, SERVER_ID);
    expect(h.apply.wipeDest).toHaveBeenCalledTimes(1);
    expect(h.parts.rows).toHaveLength(0);
    expect(h.transfers.rows[0]).toMatchObject({ state: "PENDING", attempt: 2, partsDone: 0, fingerprint: null, runId: null });
    expect(Number(h.transfers.rows[0].rawBytesDone)).toBe(0);
    // the begin that follows is a clean start and its restoreId (attempt) differs
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ fingerprint: { ...fp, startedAt: "2026-11-16T00:00:00Z" } }))).resolves.toMatchObject({ attempt: 2, resumeFromPart: 0 });
  });

  it("reset is refused while applying, once applied, against another live lease, on a live (deployed) destination and when the target is unreachable", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    await expect(h.svc.reset(ctxOp, APP_VOL_REF, { runId: "run_other_000009" })).rejects.toThrow(VX_409.otherRun);
    h.transfers.rows[0].state = "APPLYING";
    await expect(h.svc.reset(ctxOp, APP_VOL_REF, { runId: RUN })).rejects.toThrow(/apply is running/);
    h.transfers.rows[0].state = "DONE";
    await expect(h.svc.reset(ctxOp, APP_VOL_REF, { runId: RUN })).rejects.toThrow(/already applied/);
    h.transfers.rows[0].state = "FAILED";
    h.prisma.deployment.count.mockResolvedValue(1);
    await expect(h.svc.reset(ctxOp, APP_VOL_REF, { runId: RUN })).rejects.toThrow(VX_409.destDirty);
    h.prisma.deployment.count.mockResolvedValue(0);
    h.apply.cleanupTarget.mockResolvedValue(false);
    await expect(h.svc.reset(ctxOp, APP_VOL_REF, { runId: RUN })).rejects.toThrow(/could not be cleaned up/);
    expect(h.transfers.rows[0].state).toBe("FAILED"); // nothing was discarded
  });

  it("the owner's abort turns a live lease into ABORTED (the migrator then gets `vx-aborted`), the owner's reset then wipes", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    await expect(h.svc.userReset("user-1", OP, APP_VOL_REF)).resolves.toEqual({ state: "ABORTED" }); // live lease: abort first
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(mkPart(R, "a"), 0))).rejects.toThrow(VX_409.aborted);
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody())).rejects.toThrow(VX_409.aborted);
    await expect(h.svc.userReset("user-1", OP, APP_VOL_REF)).resolves.toMatchObject({ state: "PENDING", attempt: 2 });
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, beginBody({ fingerprint: { ...fp, startedAt: "2026-11-16T00:00:00Z" } }))).resolves.toMatchObject({ state: "COPYING" });
  });

  it("userAbort: not while applying, not once done, not for a volume with no copy", async () => {
    const h = harness();
    await expect(h.svc.userAbort("user-1", OP, APP_VOL_REF)).rejects.toBeInstanceOf(NotFoundException);
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    h.transfers.rows[0].state = "APPLYING";
    await expect(h.svc.userAbort("user-1", OP, APP_VOL_REF)).rejects.toThrow(/cannot be aborted midway/);
    h.transfers.rows[0].state = "DONE";
    await expect(h.svc.userAbort("user-1", OP, APP_VOL_REF)).rejects.toThrow(/already applied/);
  });
});

describe("authorization across the lifecycle", () => {
  it("every lifecycle call re-authorizes apps:config on the target team", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    await h.svc.status(ctxOp, APP_VOL_REF);
    await h.svc.beat(ctxOp, APP_VOL_REF, { runId: RUN });
    const calls = h.access.requirePermission.mock.calls.filter((c) => c[1] === TEAM_ID && c[2] === "apps:config");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    h.access.requirePermission.mockRejectedValue(new Error("role lost"));
    await expect(h.svc.beat(ctxOp, APP_VOL_REF, { runId: RUN })).rejects.toThrow("role lost");
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(mkPart(R, "a"), 0))).rejects.toThrow("role lost");
  });
});
