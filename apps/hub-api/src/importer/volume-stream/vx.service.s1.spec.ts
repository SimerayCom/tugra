import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { harness } from "./testing/vx-harness";
import { appTask, dbTask, opRow, APP_ID, APP_VOL_REF, DB_ID, DB_VOL_REF, GiB, OP, RUN, SERVER_ID, TEAM_ID, probeOutput } from "./testing/vx-fixtures";
import { dbVolumeName } from "../../databases/database-script";
import { VxInventoryItemSchema } from "./vx.dto";

const ctxOp = { opId: OP, actorId: "user-1", expiresAt: new Date(Date.now() + 1_800_000) };
const inv = (over: Record<string, unknown> = {}) => ({ itemRef: APP_VOL_REF, found: true, mountType: "volume" as const, rawBytes: 5 * GiB, entries: 10, specials: { sockets: 0, fifos: 0, devices: 0 }, running: false, exitCode: 0, ...over });

afterEach(() => {
  delete process.env.MIGRATION_VX_ENABLED;
});

describe("VxService.resolve (authz + destination derivation)", () => {
  it("derives the destination ONLY from the op's DONE tasks, re-authorizes apps:config, names the docker volume itself", async () => {
    const h = harness();
    const ctx = await h.svc.resolve(OP, "user-1", APP_VOL_REF);
    expect(ctx).toMatchObject({ targetServerId: SERVER_ID, teamId: TEAM_ID, resourceType: "application", resourceId: APP_ID, dockerVolume: `tugra_appv_${APP_ID}_data` });
    expect(ctx.target.mountPath).toBe("/var/www/data");
    expect(h.access.requirePermission).toHaveBeenCalledWith("user-1", TEAM_ID, "apps:config");
  });
  it("db-data needs apps:config AND databases; carries the credentials flag; volume is the DB's data volume", async () => {
    const h = harness();
    const ctx = await h.svc.resolve(OP, "user-1", DB_VOL_REF);
    expect(ctx).toMatchObject({ resourceType: "database", resourceId: DB_ID, credentialsCarried: true, dockerVolume: dbVolumeName({ id: DB_ID }) });
    expect(h.access.requirePermission.mock.calls.map((c) => c[2])).toEqual(["apps:config", "databases"]);
  });
  it("a lost role is refused before anything else (the rejection propagates)", async () => {
    const h = harness();
    h.access.requirePermission.mockRejectedValue(new Error("forbidden"));
    await expect(h.svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toThrow("forbidden");
  });
  it("an itemRef that is not one of the op's volume targets is the uniform 404 (malformed, unknown, undeclared, db without volume mode)", async () => {
    const h = harness();
    for (const ref of ["nope", "volume:srv1:other:data", "volume:srv1:5f3a9c:other", "volume:s:a:b:c"]) await expect(h.svc.resolve(OP, "user-1", ref)).rejects.toBeInstanceOf(NotFoundException);
    const h2 = harness({ op: { meta: { sourceKind: "coolify", serverId: SERVER_ID, plan: { items: [] } } } });
    await expect(h2.svc.resolve(OP, "user-1", DB_VOL_REF)).rejects.toBeInstanceOf(NotFoundException);
  });
  it("refuses a clustered app, a destination on another server/team, a gone destination and a volume no longer declared", async () => {
    await expect(harness({ app: { clusterId: "c1" } }).svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toThrow(/clustered/);
    await expect(harness({ app: { serverId: "other" } }).svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toThrow(/does not belong/);
    await expect(harness({ app: { teamId: "other" } }).svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toThrow(/does not belong/);
    await expect(harness({ app: null }).svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toBeInstanceOf(ConflictException);
    await expect(harness({ app: { volumes: [] } }).svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toBeInstanceOf(NotFoundException);
    await expect(harness({ db: { serverId: "other" } }).svc.resolve(OP, "user-1", DB_VOL_REF)).rejects.toThrow(/does not belong/);
    await expect(harness({ server: null }).svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toThrow(/target server/);
  });
  it("multi-host: a destination placed on another target server resolves against ITS server; one that is anywhere else is refused", async () => {
    const placed = { op: opRow({ tasks: [appTask({ serverId: "tgt-2" }), dbTask({ serverId: "tgt-2" })] }) };
    const app = await harness({ ...placed, app: { serverId: "tgt-2" } }).svc.resolve(OP, "user-1", APP_VOL_REF);
    expect(app.targetServerId).toBe("tgt-2");
    const db = await harness({ ...placed, db: { serverId: "tgt-2" } }).svc.resolve(OP, "user-1", DB_VOL_REF);
    expect(db.targetServerId).toBe("tgt-2");
    // the resource sits on the op's default server while its task says it was placed on tgt-2 (moved since): refused
    await expect(harness({ ...placed }).svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toThrow(/does not belong/);
    await expect(harness({ ...placed }).svc.resolve(OP, "user-1", DB_VOL_REF)).rejects.toThrow(/does not belong/);
  });
  it("the kill switch makes every vx lookup a 404", async () => {
    process.env.MIGRATION_VX_ENABLED = "false";
    await expect(harness().svc.resolve(OP, "user-1", APP_VOL_REF)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("VxService.inventory", () => {
  it("validates against the op's targets, merges atomically into meta.vxInventory, renews the token when it can", async () => {
    const h = harness();
    const res = await h.svc.inventory(ctxOp, { runId: RUN, items: [inv()] });
    expect(res.stored).toBe(1);
    expect(res.expiresAt).toBe(((await h.tokens.extend.mock.results[0].value) as Date).toISOString());
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = h.prisma.$executeRaw.mock.calls[0][0] as { strings?: string[]; values: unknown[] };
    expect(sql.values.join("|")).toContain(APP_VOL_REF);
    expect(sql.values[sql.values.length - 1]).toBe(OP);
    const patch = JSON.parse(sql.values[0] as string);
    expect(patch[APP_VOL_REF]).toMatchObject({ rawBytes: 5 * GiB, runId: RUN });
  });
  it("keeps the measured link speed of a volume (--speedtest-mib) and refuses a nonsensical one", async () => {
    const h = harness();
    await h.svc.inventory(ctxOp, { runId: RUN, items: [inv({ speedMBps: 42.5 })] });
    const patch = JSON.parse((h.prisma.$executeRaw.mock.calls[0][0] as { values: unknown[] }).values[0] as string);
    expect(patch[APP_VOL_REF]).toMatchObject({ speedMBps: 42.5 });
    for (const bad of [0, -3, 1e9, Number.NaN]) expect(VxInventoryItemSchema.safeParse({ ...inv(), speedMBps: bad }).success).toBe(false);
    expect(VxInventoryItemSchema.safeParse(inv()).success).toBe(true);
  });
  it("falls back to the token's own expiry when no renewal is allowed (no transfer yet)", async () => {
    const h = harness();
    h.tokens.extend.mockResolvedValue(null);
    expect((await h.svc.inventory(ctxOp, { runId: RUN, items: [inv()] })).expiresAt).toBe(ctxOp.expiresAt.toISOString());
  });
  it("rejects a volume that is not a target and a duplicated item (400), without writing", async () => {
    const h = harness();
    await expect(h.svc.inventory(ctxOp, { runId: RUN, items: [inv({ itemRef: "volume:srv1:zzz:data" })] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.inventory(ctxOp, { runId: RUN, items: [inv(), inv()] })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it("re-authorizes apps:config on the target server's team", async () => {
    const h = harness();
    await h.svc.inventory(ctxOp, { runId: RUN, items: [inv()] });
    expect(h.access.requirePermission).toHaveBeenCalledWith("user-1", TEAM_ID, "apps:config");
  });
  it("is a 404 when the stream is disabled", async () => {
    process.env.MIGRATION_VX_ENABLED = "false";
    await expect(harness().svc.inventory(ctxOp, { runId: RUN, items: [inv()] })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("VxService.diskCheck / diskVerdictFor", () => {
  const vol = `tugra_appv_${APP_ID}_data`;
  it("reads ONLY the target (probe script has no source side), applies the sizing rule and stores the verdict", async () => {
    const h = harness({ op: { meta: { sourceKind: "coolify", serverId: SERVER_ID } } });
    const v = await h.svc.diskCheck(OP, "user-1", APP_VOL_REF, 10 * GiB);
    expect(v).toMatchObject({ ok: true, unknown: false });
    expect(h.agentWs.sendCommand).toHaveBeenCalledTimes(1);
    expect(h.agentWs.sendCommand.mock.calls[0][0]).toBe(SERVER_ID);
    expect(h.agentWs.sendCommand.mock.calls[0][1]).toContain("TUGRA_PROBE_END");
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(1); // verdict persisted
  });
  it("one filesystem needs 2.05x + 1 GiB: 29 GiB + WAL on 60 GiB free is refused, on 70 GiB accepted", async () => {
    const raw = Math.round(31.8 * GiB);
    const out = (freeGb: number) => ({ exitCode: 0, output: probeOutput(vol, { stageKb: freeGb * 1024 * 1024, dockerKb: freeGb * 1024 * 1024, sameDev: true }) });
    expect((await harness({ probe: out(60) }).svc.diskCheck(OP, "user-1", APP_VOL_REF, raw)).ok).toBe(false);
    expect((await harness({ probe: out(70) }).svc.diskCheck(OP, "user-1", APP_VOL_REF, raw)).ok).toBe(true);
  });
  it("fails CLOSED on an offline agent, an old agent, a missing capability, a failed or malformed probe, an unreadable df", async () => {
    const unknown = async (o: Parameters<typeof harness>[0]) => {
      const v = await harness(o).svc.diskCheck(OP, "user-1", APP_VOL_REF, GiB);
      expect(v.ok).toBe(false);
      return v.unknown;
    };
    expect(await unknown({ online: false })).toBe(true);
    expect(await unknown({ supportsOrigin: false })).toBe(true);
    expect(await unknown({ server: { capabilities: ["deploy"] } })).toBe(true);
    expect(await unknown({ probe: { exitCode: 1, output: "" } })).toBe(true);
    expect(await unknown({ probe: { exitCode: 0, output: "TUGRA_DF /var/lib/docker 1 1\n" } })).toBe(true); // truncated: no end marker
    expect(await unknown({ probe: new Error("boom") })).toBe(true);
    expect(await unknown({ probe: { exitCode: 0, output: probeOutput(vol, { stageKb: null }) } })).toBe(true);
  });
  it("uses the stored inventory bytes when none is given; refuses when there is neither", async () => {
    const withInv = harness({ op: { meta: { sourceKind: "coolify", serverId: SERVER_ID, vxInventory: { [APP_VOL_REF]: inv({ rawBytes: 2 * GiB }) } } } });
    withInv.prisma.bulkOperation.findUnique.mockResolvedValue({ meta: withInv.op.meta });
    expect((await withInv.svc.diskCheck(OP, "user-1", APP_VOL_REF)).details.totalBytes).toBe(2 * GiB);
    await expect(harness().svc.diskCheck(OP, "user-1", APP_VOL_REF)).rejects.toBeInstanceOf(ConflictException);
  });
  it("a volume over the per-volume limit is refused without probing", async () => {
    process.env.MIGRATION_VX_MAX_BYTES = String(2 * GiB);
    const h = harness();
    const v = await h.svc.diskCheck(OP, "user-1", APP_VOL_REF, 3 * GiB);
    delete process.env.MIGRATION_VX_MAX_BYTES;
    expect(v).toMatchObject({ ok: false, unknown: false });
    expect(h.agentWs.sendCommand).not.toHaveBeenCalled();
  });
});

describe("VxService.setExcluded (explicit not-migrated)", () => {
  it("records the exclusion in meta atomically and re-includes it", async () => {
    const h = harness();
    expect(await h.svc.setExcluded("user-1", OP, APP_VOL_REF, true, "58 GB ClickHouse")).toEqual({ itemRef: APP_VOL_REF, excluded: true });
    const v = (h.prisma.$executeRaw.mock.calls[0][0] as { values: unknown[] }).values;
    expect(JSON.parse(v[0] as string)[APP_VOL_REF]).toMatchObject({ reason: "58 GB ClickHouse", by: "user-1" });
    await h.svc.setExcluded("user-1", OP, APP_VOL_REF, false);
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });
  it("refuses once the volume is being copied or was copied", async () => {
    const h = harness();
    h.prisma.migrationVolumeTransfer.findUnique.mockResolvedValue({ state: "COPYING" });
    await expect(h.svc.setExcluded("user-1", OP, APP_VOL_REF, true)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("VxService targets + view", () => {
  it("targetRows: additive volume rows; db-data marks the DB row; no host paths, credentials or tokens", async () => {
    const h = harness();
    const { rows, volumeRefOfDb } = await h.svc.targetRows(h.op as never);
    expect(rows).toEqual([
      { itemRef: APP_VOL_REF, kind: "volume", volumeIngest: "stream-v2", dest: { type: "app-volume", name: "data", mountPath: "/var/www/data" }, appItemRef: "app:srv1:5f3a9c" },
      { itemRef: DB_VOL_REF, kind: "volume", volumeIngest: "stream-v2", dest: { type: "db-data", name: "data", mountPath: "/var/lib/postgresql/data" }, databaseItemRef: "database:srv1:pg7c1", engine: "POSTGRES", engineVersion: "16", sourceImage: "postgres:16-alpine" },
    ]);
    expect(volumeRefOfDb.get("database:srv1:pg7c1")).toBe(DB_VOL_REF);
    const json = JSON.stringify(rows);
    expect(json).not.toMatch(/tugra_appv|tugra_dbv|password|token|\/etc\/tugra/i);
  });
  it("targetRows: an app volume row carries the plan's custom container name prefix for the migrator's resolver (a bad value never travels)", async () => {
    const withPrefix = harness({ op: { meta: { sourceKind: "coolify", serverId: SERVER_ID, plan: { items: [{ itemRef: "app:srv1:5f3a9c", kind: "app", proposed: { containerPrefix: "shop" } }] } } } });
    const { rows } = await withPrefix.svc.targetRows(withPrefix.op as never);
    expect(rows[0]).toMatchObject({ itemRef: APP_VOL_REF, appItemRef: "app:srv1:5f3a9c", containerPrefix: "shop" });
    const bad = harness({ op: { meta: { sourceKind: "coolify", serverId: SERVER_ID, plan: { items: [{ itemRef: "app:srv1:5f3a9c", kind: "app", proposed: { containerPrefix: "x; id" } }] } } } });
    expect(((await bad.svc.targetRows(bad.op as never)).rows[0] as Record<string, unknown>).containerPrefix).toBeUndefined();
  });
  it("an excluded volume is advertised as `excluded` with its reason (never silently dropped)", async () => {
    const h = harness({ op: { meta: { sourceKind: "coolify", serverId: SERVER_ID, plan: { items: [] }, vxExcluded: { [APP_VOL_REF]: { reason: "owner chose", at: "x", by: "u" } } } } });
    const { rows } = await h.svc.targetRows(h.op as never);
    expect(rows[0]).toMatchObject({ itemRef: APP_VOL_REF, volumeIngest: "excluded", reason: "owner chose" });
  });
  it("disabled: no rows and an empty envelope", async () => {
    process.env.MIGRATION_VX_ENABLED = "false";
    const h = harness();
    expect((await h.svc.targetRows(h.op as never)).rows).toEqual([]);
    expect(h.svc.targetsEnvelope()).toEqual({});
  });
  it("envelope advertises the protocol and the policy", () => {
    expect(harness().svc.targetsEnvelope()).toEqual({ vxProtocol: 1, vx: { partRawBytes: 128 * 1024 ** 2, maxBytes: 256 * GiB, maxParts: 100000, dumpMaxBytes: 1024 * GiB } });
  });
  it("listVolumes: merges inventory, disk verdict and the Postgres gates; labelled as reported by the migrator", async () => {
    const meta = { sourceKind: "coolify", serverId: SERVER_ID, plan: { items: [{ itemRef: "database:srv1:pg7c1", kind: "database", proposed: { dataMode: "volume" } }] }, vxInventory: { [DB_VOL_REF]: inv({ itemRef: DB_VOL_REF, image: "postgres:16-alpine", pgMajor: "16", pgLayout: "root", mountDest: "/var/lib/postgresql/data" }) }, vxDisk: { [DB_VOL_REF]: { ok: true, unknown: false, details: { totalBytes: 5 * GiB } } } };
    const h = harness({ op: { meta } });
    const r = await h.svc.listVolumes("user-1", OP);
    expect(r.enabled).toBe(true);
    const db = r.volumes.find((v) => v.itemRef === DB_VOL_REF)!;
    expect(db.gates!.every((g) => g.status === "pass")).toBe(true);
    expect(db).toMatchObject({ state: "NONE", resourceName: "pg", evidenceNote: "reported by the migrator", diskVerdict: { ok: true } });
    expect(db.inventory).toMatchObject({ pgMajor: "16", pgLayout: "root" });
    const app = r.volumes.find((v) => v.itemRef === APP_VOL_REF)!;
    expect(app).toMatchObject({ resourceName: "web", gates: null, inventory: null });
    expect(h.access.requirePermission).toHaveBeenCalledWith("user-1", TEAM_ID, "apps:config");
  });
  it("listVolumes: db-data gates fail closed when the source was never inspected", async () => {
    const r = await harness().svc.listVolumes("user-1", OP);
    const db = r.volumes.find((v) => v.destType === "db-data")!;
    expect(db.gates!.find((g) => g.id === "inventory")!.status).toBe("unknown");
  });
  it("listVolumes when disabled", async () => {
    process.env.MIGRATION_VX_ENABLED = "false";
    expect(await harness().svc.listVolumes("user-1", OP)).toEqual({ volumes: [], tokenExpiresAt: null, enabled: false });
  });
});
