import { ConflictException, NotFoundException } from "@nestjs/common";
import { buildVolumeTargets, isObjectStoreResult, serviceVolumeName, serviceVolumeStreamable, serviceVolumesOf, validServiceMountPath } from "./vx-targets";
import { VxApplyService } from "./vx-apply.service";
import { VxPartRegistry } from "./vx-part-registry";
import { harness } from "./testing/vx-harness";
import { memTasks, memTransfers } from "./testing/vx-memdb";
import { OP, SERVER_ID, TEAM_ID, opRow } from "./testing/vx-fixtures";
import type { VxCtx } from "./vx.service";

// Neutral invented names only: a search-engine service (volume with data), a converter service (no data).
const SVC_REF = "service:srv1:svc7a1";
const SVC_ID = "cksvc00000000000000000001";
const SVC_VOL_REF = "volume:srv1:svc7a1:search-data";
const svcResult = (volumes: unknown[]) => ({ kind: "service", name: "search", appId: SVC_ID, members: ["search"], volumes });
const vol = (key: string, over: Record<string, unknown> = {}) => ({ key, dockerName: `tugra_${SVC_ID}_${key}`, policy: "copy", dataPlane: "hub-staged", state: "pending-data", mounts: [{ service: "search", path: "/data.ms" }], ...over });
const svcTask = (over: Record<string, unknown> = {}) => ({
  id: "t-svc",
  itemRef: SVC_REF,
  kind: "service",
  status: "DONE",
  resourceType: "application",
  resourceId: SVC_ID,
  result: svcResult([vol("search-data")]),
  steps: null,
  ...over,
});
const noDbs = new Map();
const lite = (t: ReturnType<typeof svcTask>) => ({ itemRef: t.itemRef, kind: t.kind, status: t.status, resourceType: t.resourceType, resourceId: t.resourceId, result: t.result });

describe("buildVolumeTargets: compose services", () => {
  it("a DONE service task yields an app-volume target per copy volume, owned by the service, with the source mount path", () => {
    const t = buildVolumeTargets({ tasks: [lite(svcTask())], dbs: noDbs, dbVolumeRefs: new Set() });
    expect(t).toEqual([{ itemRef: SVC_VOL_REF, destType: "app-volume", name: "search-data", mountPath: "/data.ms", appItemRef: SVC_REF, ownerKind: "service" }]);
  });
  it("skips policy skip/empty, a task that is not DONE, a volume with no recorded mount and a key the stream cannot name", () => {
    const result = svcResult([vol("a", { policy: "skip" }), vol("b", { policy: "empty" }), vol("nomount", { mounts: [] }), vol("Upper"), vol("with.dot"), vol("ok-1")]);
    expect(buildVolumeTargets({ tasks: [lite(svcTask({ result }))], dbs: noDbs, dbVolumeRefs: new Set() }).map((x) => x.name)).toEqual(["ok-1"]);
    expect(buildVolumeTargets({ tasks: [lite(svcTask({ status: "FAILED" }))], dbs: noDbs, dbVolumeRefs: new Set() })).toEqual([]);
    expect(buildVolumeTargets({ tasks: [lite(svcTask({ result: { kind: "service" } }))], dbs: noDbs, dbVolumeRefs: new Set() })).toEqual([]);
  });
  it("takes the first usable mount of a volume shared by several members and refuses an unsafe path", () => {
    const shared = vol("shared", { mounts: [{ service: "a", path: "../etc" }, { service: "b", path: "/srv/x" }, { service: "c", path: "/srv/y" }] });
    expect(serviceVolumesOf({ volumes: [shared] })).toEqual([{ key: "shared", policy: "copy", mountPath: "/srv/x" }]);
    for (const bad of ["", "rel/path", "/a/../b", "/a b", "/a;rm", "/a\nb", "/" + "x".repeat(400), 7, null]) expect(validServiceMountPath(bad)).toBe(false);
    expect(validServiceMountPath("/data.ms")).toBe(true);
    expect(serviceVolumeStreamable({ key: "k", policy: "copy", mountPath: null })).toBe(false);
  });
  it("an object store (MinIO) service gets NO volume target: its buckets move only through Object migration", () => {
    const store = svcTask({ result: { ...svcResult([vol("minio-data", { mounts: [{ service: "minio", path: "/data" }] })]), members: ["minio", "console"] } });
    expect(buildVolumeTargets({ tasks: [lite(store)], dbs: noDbs, dbVolumeRefs: new Set() })).toEqual([]);
    expect(isObjectStoreResult(store.result)).toBe(true);
    expect(isObjectStoreResult(svcTask().result)).toBe(false);
    expect(isObjectStoreResult({ members: "minio" })).toBe(false);
    expect(isObjectStoreResult(null)).toBe(false);
  });
  it("marks an explicit exclusion on a service volume like on any other", () => {
    const t = buildVolumeTargets({ tasks: [lite(svcTask())], dbs: noDbs, dbVolumeRefs: new Set(), excluded: { [SVC_VOL_REF]: { reason: "rebuilt from the database", at: "x", by: "u" } } });
    expect(t[0].excluded).toEqual({ reason: "rebuilt from the database", at: "x", by: "u" });
  });
  it("names the docker volume the way the service's compose project does", () => {
    expect(serviceVolumeName({ id: SVC_ID }, "search-data")).toBe(`tugra_${SVC_ID}_search-data`);
  });
});

const ctxOp = { opId: OP, actorId: "user-1", expiresAt: new Date(Date.now() + 1_800_000) };
const svcHarness = (over: Parameters<typeof harness>[0] = {}) => harness({ op: opRow({ tasks: [svcTask()] }), app: { id: SVC_ID, volumes: [], name: "search" }, ...over });

describe("VxService: a compose service volume", () => {
  it("resolves against the service's app (no declared volumes), names the compose project volume and re-authorizes apps:config", async () => {
    const h = svcHarness();
    const ctx = await h.svc.resolve(OP, "user-1", SVC_VOL_REF);
    expect(ctx).toMatchObject({ resourceType: "application", resourceId: SVC_ID, ownerTaskItemRef: SVC_REF, dockerVolume: `tugra_${SVC_ID}_search-data`, targetServerId: SERVER_ID, teamId: TEAM_ID });
    expect(ctx.target).toMatchObject({ destType: "app-volume", mountPath: "/data.ms", ownerKind: "service" });
    expect(h.access.requirePermission).toHaveBeenCalledWith("user-1", TEAM_ID, "apps:config");
  });
  it("lists the volume on GET targets as an app-volume row owned by the service", async () => {
    const h = svcHarness();
    const { rows } = await h.svc.targetRows({ id: OP, meta: h.op.meta, tasks: h.op.tasks as never });
    expect(rows).toEqual([{ itemRef: SVC_VOL_REF, kind: "volume", volumeIngest: "stream-v2", dest: { type: "app-volume", name: "search-data", mountPath: "/data.ms" }, appItemRef: SVC_REF }]);
  });
  it("an undeclared service volume, a clustered or foreign destination and a gone app are refused like an app volume", async () => {
    await expect(svcHarness().svc.resolve(OP, "user-1", "volume:srv1:svc7a1:other")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svcHarness({ app: { id: SVC_ID, clusterId: "c1" } }).svc.resolve(OP, "user-1", SVC_VOL_REF)).rejects.toThrow(/clustered/);
    await expect(svcHarness({ app: { id: SVC_ID, serverId: "other" } }).svc.resolve(OP, "user-1", SVC_VOL_REF)).rejects.toThrow(/does not belong/);
    await expect(svcHarness({ app: null }).svc.resolve(OP, "user-1", SVC_VOL_REF)).rejects.toBeInstanceOf(ConflictException);
  });
  it("the claim stamps the service as owner on the data task, and a deployed service is dirty (the data must arrive before the first start)", async () => {
    const R = 128 * 1024 * 1024;
    const fp = { containerId: "c".repeat(64), startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-14T10:00:00Z", exitCode: 0, mountType: "volume" as const, mountName: "svc7a1_search-data", imageId: "sha256:img1" };
    const h = svcHarness();
    const r = (await h.svc.begin(ctxOp, SVC_VOL_REF, { runId: "run_abcdef012345", partRawBytes: R, rawTotal: 1024, fingerprint: fp })) as Record<string, unknown>;
    expect(r).toMatchObject({ state: "COPYING", resumeFromPart: 0 });
    expect(h.transfers.rows[0]).toMatchObject({ destType: "app-volume", dockerVolume: `tugra_${SVC_ID}_search-data`, resourceId: SVC_ID });
    const task = h.tasks.rows.find((t) => t.itemRef === `data:${SVC_VOL_REF}`)!;
    expect(task).toMatchObject({ kind: "data", status: "RUNNING" });
    expect(task.result).toMatchObject({ vx: true, appItemRef: SVC_REF, volumeName: "search-data" });
    // the app already has a deployment: a later begin on a second volume is refused (a live volume is never wiped)
    const dirty = svcHarness();
    dirty.prisma.deployment.count.mockResolvedValue(1);
    await expect(dirty.svc.begin(ctxOp, SVC_VOL_REF, { runId: "run_abcdef012345", partRawBytes: R, rawTotal: 1024, fingerprint: fp })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("VxApplyService: a compose service volume", () => {
  function make() {
    const transfers = memTransfers();
    const tasks = memTasks();
    const sent: string[] = [];
    const agentWs = { sendCommand: jest.fn(async (_s: string, script: string) => (sent.push(script), { exitCode: 0, output: script.includes("applying.lock") || script.includes("TUGRA_VX_APPLY_OK") ? "TUGRA_VX_APPLY_OK entries=42\n" : "" })) };
    const prisma = {
      migrationVolumeTransfer: transfers,
      bulkTask: tasks,
      bulkOperation: { findUnique: jest.fn().mockResolvedValue({ meta: { vxInventory: {} }, actorId: "user-1" }) },
      deployment: { count: jest.fn().mockResolvedValue(0) },
    };
    const apply = new VxApplyService(prisma as never, agentWs as never, {} as never, { log: jest.fn().mockResolvedValue(undefined) } as never, new VxPartRegistry(), { decrypt: jest.fn((v: string) => v) } as never);
    return { apply, transfers, tasks, sent };
  }
  const ctx = (): VxCtx => ({
    opId: OP, actorId: "user-1", target: { itemRef: SVC_VOL_REF, destType: "app-volume", name: "search-data", mountPath: "/data.ms", appItemRef: SVC_REF, ownerKind: "service" },
    targetServerId: SERVER_ID, teamId: TEAM_ID, dockerVolume: `tugra_${SVC_ID}_search-data`, resourceType: "application", resourceId: SVC_ID, ownerTaskItemRef: SVC_REF,
    server: { id: SERVER_ID, teamId: TEAM_ID, capabilities: ["backup"] },
  });
  const settled = async (m: ReturnType<typeof make>, id: string) => {
    for (let i = 0; i < 200 && m.apply.isRunning(id); i++) await new Promise((r) => setTimeout(r, 5));
  };

  it("applies into the service's compose volume and ends with the data task DONE (the fact isStateful and VERIFY read)", async () => {
    const m = make();
    const row = await m.transfers.create({ data: { opId: OP, itemRef: SVC_VOL_REF, destType: "app-volume", targetServerId: SERVER_ID, dockerVolume: `tugra_${SVC_ID}_search-data`, resourceType: "application", resourceId: SVC_ID, state: "APPLYING", attempt: 1, partRawBytes: 134217728, partsDone: 2, rawBytesFinal: 1024, entries: 42, runId: "run_x", lastBeatAt: new Date() } });
    await m.tasks.create({ data: { opId: OP, itemRef: `data:${SVC_VOL_REF}`, kind: "data", status: "RUNNING", serverId: SERVER_ID, startedAt: new Date() } });
    m.apply.start(ctx(), row as never);
    await settled(m, (row as { id: string }).id);
    expect(m.transfers.rows[0]).toMatchObject({ state: "DONE", error: null });
    expect(m.sent.some((s) => s.includes(`tugra_${SVC_ID}_search-data`))).toBe(true);
    expect(m.tasks.rows.find((t) => t.itemRef === `data:${SVC_VOL_REF}`)).toMatchObject({ status: "DONE", result: { vx: true, appItemRef: SVC_REF, volumeName: "search-data" } });
  });
  it("resumes after the apply script already finished: only the post-apply steps run, the data task still ends DONE", async () => {
    const m = make();
    const row = await m.transfers.create({ data: { opId: OP, itemRef: SVC_VOL_REF, destType: "app-volume", targetServerId: SERVER_ID, dockerVolume: `tugra_${SVC_ID}_search-data`, resourceType: "application", resourceId: SVC_ID, state: "APPLYING", attempt: 1, partRawBytes: 134217728, partsDone: 2, rawBytesFinal: 1024, entries: 42, runId: "run_x", lastBeatAt: new Date() } });
    await m.tasks.create({ data: { opId: OP, itemRef: `data:${SVC_VOL_REF}`, kind: "data", status: "RUNNING", serverId: SERVER_ID, startedAt: new Date() } });
    m.apply.resumeAfterApplied(ctx(), row as never);
    await settled(m, (row as { id: string }).id);
    expect(m.sent.some((x) => x.includes("-mindepth 1 -delete") || x.includes("TUGRA_VX_APPLY_OK"))).toBe(false); // nothing is wiped or extracted again (only the staging tidy-up runs)
    expect(m.transfers.rows[0].state).toBe("DONE");
    expect(m.tasks.rows.find((t) => t.itemRef === `data:${SVC_VOL_REF}`)?.status).toBe("DONE");
  });
});
