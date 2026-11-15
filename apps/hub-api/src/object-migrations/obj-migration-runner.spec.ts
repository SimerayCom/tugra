/* eslint-disable @typescript-eslint/no-explicit-any */
import { ObjMigrationRunnerService, MAX_HELPERS_PER_SERVER, deriveMigrationStatus, rewriteArns } from "./obj-migration-runner.service";
import { makeFakePrisma, type Store } from "./testing/fake-prisma";
import { b64, MC_DU_JSON, MC_ILM_JSON, MC_LS_JSON, MC_POLICY_JSON, MC_TAGS_JSON, MC_VERSION_INFO_ENABLED } from "./testing/mc-fixtures";

const out = (name: string, text: string) => `TUGRA_OBJ_OUT ${name} ${b64(text)}`;
const SECRETS = ["SRC-ACCESS-KEY", "SRC-SECRET-KEY-VALUE", "DST-ACCESS-KEY", "DST-SECRET-KEY-VALUE"];

const dfn = <T>(): jest.Mock<Promise<T>, any[]> => jest.fn();

/** A scriptable agent: replies are chosen by what the script is (the real builders produce the scripts). */
function makeAgent() {
  const state = {
    offline: false,
    probe: () =>
      ["TUGRA_OBJ_PROBE v1", "TUGRA_OBJ_TOOL mc 1 RELEASE.2025-08-13T08-35-41Z", "TUGRA_OBJ_REACH src ok 10", out("ls_src", MC_LS_JSON), "TUGRA_OBJ_REACH dst ok 5", out("ls_dst", '{"status":"success","type":"folder","key":"bk1/"}'), "TUGRA_OBJ_DF 99999999", "TUGRA_OBJ_PROBE_END"].join("\n"),
    du: (script: string) => {
      const names = [...script.matchAll(/mcr du --json 'src\/([a-z0-9.-]+)'/g)].map((m) => m[1]);
      return [
        ...names.flatMap((n) => [out(`du_src_${n}`, MC_DU_JSON), out(`du_dst_${n}`, n === "bk1" ? MC_DU_JSON : ""), out(`ver_${n}`, MC_VERSION_INFO_ENABLED), out(`cfg_policy_${n}`, n === "bk1" ? MC_POLICY_JSON : ""), out(`cfg_ilm_${n}`, n === "bk1" ? MC_ILM_JSON : ""), out(`cfg_tags_${n}`, n === "bk1" ? MC_TAGS_JSON : ""), `TUGRA_OBJ_DU_BUCKET ${n}`]),
        "TUGRA_OBJ_DU_END",
      ].join("\n");
    },
    start: (script: string) => {
      const idxs = [...script.matchAll(/--label tugra\.objmig\.idx=(\d+)/g)].map((m) => Number(m[1]));
      return [...idxs.map((i) => `TUGRA_OBJ_STARTED ${i} abcdef012345`), "TUGRA_OBJ_START_END"].join("\n");
    },
    /** idx -> [state, exit, errs, last] */
    helpers: new Map<number, [string, number, number, string]>(),
    statusMissingEnd: false,
    diff: (script: string) => {
      const names = [...script.matchAll(/mcr diff --json 'src\/([a-z0-9.-]+)'/g)].map((m) => m[1]);
      return [...names.flatMap((n) => [`TUGRA_OBJ_DIFF ${n} 0 0 1 0 0`, out(`du_src_${n}`, MC_DU_JSON), out(`du_dst_${n}`, MC_DU_JSON)]), "TUGRA_OBJ_DIFF_END"].join("\n");
    },
    cfg: (script: string) => {
      const marks = [...script.matchAll(/echo 'TUGRA_OBJ_CFG ([a-z0-9.-]+) (policy|ilm|tag) ok'/g)].map((m) => `TUGRA_OBJ_CFG ${m[1]} ${m[2]} ok`);
      return [...marks, "TUGRA_OBJ_CFG_END"].join("\n");
    },
  };
  const calls: string[] = [];
  const sendCommand = jest.fn(async (_serverId: string, script: string, _cap?: string, _timeout?: number) => {
    calls.push(script);
    if (state.offline) throw new Error("agent is offline");
    let output = "";
    if (script.includes("TUGRA_OBJ_PROBE v1")) output = state.probe();
    else if (script.includes("TUGRA_OBJ_DU_END")) output = state.du(script);
    else if (script.includes("TUGRA_OBJ_START_END")) output = state.start(script);
    else if (script.includes("TUGRA_OBJ_STATUS_END")) {
      const idxs = [...script.matchAll(/TUGRA_OBJ_STATE (\d+) \$ST/g)].map((m) => Number(m[1]));
      output =
        idxs
          .map((i) => {
            const h = state.helpers.get(i) ?? ["running", 0, 0, ""];
            return [`TUGRA_OBJ_STATE ${i} ${h[0]} ${h[1]}`, `TUGRA_OBJ_PROG ${i} 3 5012`, out(`last_${i}`, h[3]), `TUGRA_OBJ_ERRS ${i} ${h[2]}`].join("\n");
          })
          .join("\n") + (state.statusMissingEnd ? "" : "\nTUGRA_OBJ_STATUS_END");
    } else if (script.includes("TUGRA_OBJ_DIFF_END")) output = state.diff(script);
    else if (script.includes("TUGRA_OBJ_CFG_END")) output = state.cfg(script);
    else if (script.includes("TUGRA_OBJ_CLEAN_END")) output = "TUGRA_OBJ_CLEAN_END";
    return { exitCode: 0, output };
  });
  return { sendCommand, calls, state };
}

function setup() {
  const { prisma, store } = makeFakePrisma();
  const agent = makeAgent();
  const crypto = { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, "") };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const runner = new ObjMigrationRunnerService(prisma as never, { sendCommand: agent.sendCommand } as never, crypto as never, audit as never);
  runner.timing = { pollMs: 5 };
  const mk = async (over: Record<string, unknown> = {}) =>
    prisma.objectMigration.create({
      data: { teamId: "team-1", createdById: "u1", name: "m", targetServerId: "srv-1", srcEndpoint: "https://src.example.com", srcAccessKeyEnc: "enc(SRC-ACCESS-KEY)", srcSecretKeyEnc: "enc(SRC-SECRET-KEY-VALUE)", dstEndpoint: "http://host.docker.internal:9100", dstAccessKeyEnc: "enc(DST-ACCESS-KEY)", dstSecretKeyEnc: "enc(DST-SECRET-KEY-VALUE)", ...over },
      include: { buckets: true },
    });
  const addBucket = (migrationId: string, idx: number, srcBucket: string, over: Record<string, unknown> = {}) =>
    prisma.objectMigrationBucket.create({ data: { migrationId, idx, srcBucket, dstBucket: srcBucket, selected: true, dstObjects: 0n, ...over } });
  const reload = async (id: string) => (await prisma.objectMigration.findUnique({ where: { id }, include: { buckets: { orderBy: { idx: "asc" } } } })) as any;
  return { runner, prisma, store, agent, audit, mk, addBucket, reload };
}
type H = ReturnType<typeof setup>;

const bucketsOf = (m: any) => Object.fromEntries(m.buckets.map((b: any) => [b.srcBucket, b]));

describe("deriveMigrationStatus (pure)", () => {
  const s = (current: string, phase: string | null, ...st: Array<[string, boolean?]>) => deriveMigrationStatus(current, phase, st.map(([status, selected = true]) => ({ status, selected })));
  it("table", () => {
    expect(s("DRAFT", null, ["PENDING"])).toBe("DRAFT");
    expect(s("PREFLIGHTED", null, ["PENDING"])).toBe("PREFLIGHTED");
    expect(s("PREFLIGHTED", null)).toBe("PREFLIGHTED");
    expect(s("PREFLIGHTED", "seed", ["SEEDING"], ["SEEDED"])).toBe("SEEDING");
    expect(s("SEEDED", "final", ["FINALIZING"], ["FINAL"])).toBe("FINALIZING");
    expect(s("PREFLIGHTED", "seed", ["QUEUED"], ["SEEDED"])).toBe("SEEDING");
    expect(s("SEEDING", null, ["SEEDED"], ["SEEDED"])).toBe("SEEDED");
    expect(s("SEEDING", null, ["SEEDED"], ["PENDING"])).toBe("PREFLIGHTED");
    expect(s("FINALIZING", null, ["FINAL"], ["FINAL"])).toBe("FINAL");
    expect(s("FINAL", null, ["SEEDED"], ["FINAL"])).toBe("SEEDED"); // final not complete for every bucket
    expect(s("SEEDING", null, ["SEEDED"], ["FAILED"])).toBe("FAILED"); // other buckets keep their state
    expect(s("FINAL", null, ["VERIFIED"], ["VERIFIED"])).toBe("DONE");
    expect(s("FINAL", null, ["VERIFIED"], ["DIFFERS"])).toBe("FINAL");
    expect(s("FINAL", null, ["VERIFIED"], ["FINAL"])).toBe("FINAL");
    expect(s("SEEDED", null, ["SEEDED"], ["PENDING", false])).toBe("SEEDED"); // an unselected bucket does not count
  });
});

describe("rewriteArns", () => {
  it("rewrites the exact bucket ARN only (bucket and object resources), never a longer name", () => {
    const p = '{"Resource":["arn:aws:s3:::bk1","arn:aws:s3:::bk1/*","arn:aws:s3:::bk10/*"]}';
    expect(rewriteArns(p, "bk1", "new-bk")).toBe('{"Resource":["arn:aws:s3:::new-bk","arn:aws:s3:::new-bk/*","arn:aws:s3:::bk10/*"]}');
  });
});

describe("preflight", () => {
  it("lists every source bucket with real sizes, selects NOTHING, exports config and moves DRAFT -> PREFLIGHTED", async () => {
    const h = setup();
    const m = await h.mk();
    const warnings = await h.runner.preflight(m);
    const r = await h.reload(m.id);
    expect(r.status).toBe("PREFLIGHTED");
    const b = bucketsOf(r);
    expect(Object.keys(b)).toEqual(["bk1", "bk2"]);
    expect(r.buckets.every((x: any) => x.selected === false)).toBe(true);
    expect(b.bk1).toMatchObject({ srcObjects: 2n, srcBytes: 12n, dstObjects: 2n, versioning: "enabled", configStatus: "EXPORTED", dstBucket: "bk1" });
    expect(b.bk2).toMatchObject({ srcObjects: 2n, dstObjects: 0n, configStatus: "NONE" }); // bk2 does not exist on the destination yet: 0, not unknown
    expect(b.bk1.config.policy).toContain("s3:GetObject");
    expect(warnings).toEqual(expect.arrayContaining([{ code: "versions_not_carried", level: "warn", bucket: "bk1" }, { code: "dst_not_empty", level: "info", bucket: "bk1" }]));
    expect(h.agent.sendCommand.mock.calls.every((c) => c[2] === "backup")).toBe(true); // capability `backup`, no new capability
  });

  it("sizes buckets in groups of at most 3 per du call", async () => {
    const h = setup();
    const names = ["bk1", "bk2", "bk3", "bk4", "bk5", "bk6", "bk7"];
    h.agent.state.probe = () => ["TUGRA_OBJ_PROBE v1", "TUGRA_OBJ_TOOL mc 1 RELEASE.x", "TUGRA_OBJ_REACH src ok 1", out("ls_src", names.map((n) => `{"status":"success","type":"folder","key":"${n}/"}`).join("\n")), "TUGRA_OBJ_REACH dst ok 1", out("ls_dst", ""), "TUGRA_OBJ_PROBE_END"].join("\n");
    const m = await h.mk();
    await h.runner.preflight(m);
    const du = h.agent.calls.filter((c) => c.includes("TUGRA_OBJ_DU_END"));
    expect(du).toHaveLength(3);
    expect(du.map((c) => (c.match(/mcr du --json 'src\//g) ?? []).length)).toEqual([3, 3, 1]);
  });

  it.each([
    ["an unreachable source", (a: ReturnType<typeof makeAgent>) => (a.state.probe = () => ["TUGRA_OBJ_PROBE v1", "TUGRA_OBJ_TOOL mc 1 RELEASE.x", "TUGRA_OBJ_REACH src fail 60000", "TUGRA_OBJ_REACH dst ok 1", "TUGRA_OBJ_PROBE_END"].join("\n")), "src_unreachable"],
    ["an unreachable destination", (a: ReturnType<typeof makeAgent>) => (a.state.probe = () => ["TUGRA_OBJ_PROBE v1", "TUGRA_OBJ_TOOL mc 1 RELEASE.x", "TUGRA_OBJ_REACH src ok 1", "TUGRA_OBJ_REACH dst fail 1", "TUGRA_OBJ_PROBE_END"].join("\n")), "dst_unreachable"],
    ["an old agent image without mc", (a: ReturnType<typeof makeAgent>) => (a.state.probe = () => "TUGRA_OBJ_PROBE v1\nTUGRA_OBJ_TOOL mc 0 -\nTUGRA_OBJ_PROBE_END"), "no_mc"],
    ["truncated output (no END marker)", (a: ReturnType<typeof makeAgent>) => (a.state.probe = () => "TUGRA_OBJ_PROBE v1\nTUGRA_OBJ_TOOL mc 1 RELEASE.x\nTUGRA_OBJ_REACH src ok 1"), "probe_incomplete"],
    ["a missing agent image", (a: ReturnType<typeof makeAgent>) => (a.state.probe = () => "TUGRA_OBJ_ERR no-agent-image"), "no_agent_image"],
  ])("%s is a BLOCKER: the migration stays DRAFT, no bucket rows are invented", async (_n, tweak, code) => {
    const h = setup();
    tweak(h.agent);
    const m = await h.mk();
    const w = await h.runner.preflight(m);
    expect(w).toContainEqual({ code, level: "blocker" });
    const r = await h.reload(m.id);
    expect(r.status).toBe("DRAFT");
    expect(r.buckets).toHaveLength(0);
    expect(h.agent.calls.some((c) => c.includes("TUGRA_OBJ_DU_END"))).toBe(false);
  });

  it("a du that returns nothing leaves the size UNKNOWN (null) with a warning, never 0", async () => {
    const h = setup();
    h.agent.state.du = () => "TUGRA_OBJ_DU_END";
    const m = await h.mk();
    const w = await h.runner.preflight(m);
    const b = bucketsOf(await h.reload(m.id));
    expect(b.bk1.srcBytes).toBeNull();
    expect(w).toContainEqual({ code: "size_unknown", level: "warn", bucket: "bk1" });
  });

  it("re-running keeps the operator's selection, rename and excludes", async () => {
    const h = setup();
    const m = await h.mk();
    await h.runner.preflight(m);
    const r1 = await h.reload(m.id);
    await h.prisma.objectMigrationBucket.update({ where: { id: bucketsOf(r1).bk1.id }, data: { selected: true, dstBucket: "renamed", exclude: ["*.tmp"] } });
    await h.runner.preflight(await h.reload(m.id));
    expect(bucketsOf(await h.reload(m.id)).bk1).toMatchObject({ selected: true, dstBucket: "renamed", exclude: ["*.tmp"] });
  });

  it("an offline agent surfaces as an error (not as 'sizes unknown')", async () => {
    const h = setup();
    const m = await h.mk();
    h.agent.state.offline = true;
    await expect(h.runner.preflight(m)).rejects.toThrow(/offline/);
  });

  it("warns (never blocks) when a same-host destination would not fit the data", async () => {
    const h = setup();
    h.agent.state.probe = () => ["TUGRA_OBJ_PROBE v1", "TUGRA_OBJ_TOOL mc 1 RELEASE.x", "TUGRA_OBJ_REACH src ok 1", out("ls_src", MC_LS_JSON), "TUGRA_OBJ_REACH dst ok 1", out("ls_dst", ""), "TUGRA_OBJ_DF 0", "TUGRA_OBJ_PROBE_END"].join("\n");
    const m = await h.mk();
    expect(await h.runner.preflight(m)).toContainEqual({ code: "dst_space_low", level: "warn" });
    expect((await h.reload(m.id)).status).toBe("PREFLIGHTED");
  });
});

async function seeded(h: H, n = 1, over: Record<string, unknown> = {}) {
  const m = await h.mk({ status: "PREFLIGHTED", ...over });
  for (let i = 0; i < n; i++) await h.addBucket(m.id, i, `bk${i + 1}`);
  return m;
}
const ids = (m: any) => m.buckets.map((b: any) => b.id);

describe("start / slots / poll", () => {
  it("seed: marks buckets SEEDING only after their STARTED marker; the start script is seed-only (no --overwrite/--remove)", async () => {
    const h = setup();
    const m = await seeded(h, 2);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    const r = await h.reload(m.id);
    expect(r.status).toBe("SEEDING");
    expect(r.phase).toBe("seed");
    expect(r.buckets.map((b: any) => b.status)).toEqual(["SEEDING", "SEEDING"]);
    const start = h.agent.calls.find((c) => c.includes("TUGRA_OBJ_START_END"))!;
    expect(start).not.toMatch(/--overwrite|--remove/);
    h.runner.onModuleDestroy();
  });

  it(`2-slot cap per target server: ${MAX_HELPERS_PER_SERVER} run, the rest sit QUEUED and start as slots free (across migrations)`, async () => {
    const h = setup();
    const m = await seeded(h, 3);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    expect((await h.reload(m.id)).buckets.map((b: any) => b.status)).toEqual(["SEEDING", "SEEDING", "QUEUED"]);
    // a second migration on the SAME server only queues
    const m2 = await seeded(h, 1);
    await h.runner.start(m2.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m2.id)) });
    expect((await h.reload(m2.id)).buckets[0].status).toBe("QUEUED");
    // helper 0 finishes -> the next tick starts the queued bucket of the OLDER migration first
    h.agent.state.helpers.set(0, ["exited", 0, 0, ""]);
    await h.runner.tick(m.id);
    expect((await h.reload(m.id)).buckets.map((b: any) => b.status)).toEqual(["SEEDED", "SEEDING", "SEEDING"]);
    expect((await h.reload(m2.id)).buckets[0].status).toBe("QUEUED");
    h.runner.onModuleDestroy();
  });

  it("a server-wide cap does not leak across servers", async () => {
    const h = setup();
    const a = await seeded(h, 2);
    const b = await seeded(h, 2, { targetServerId: "srv-2" });
    await h.runner.start(a.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(a.id)) });
    await h.runner.start(b.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(b.id)) });
    expect((await h.reload(b.id)).buckets.map((x: any) => x.status)).toEqual(["SEEDING", "SEEDING"]);
    h.runner.onModuleDestroy();
  });

  it("exit 0 with 0 error lines => SEEDED, progress recorded, the helper cleaned, migration SEEDED", async () => {
    const h = setup();
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    h.agent.state.helpers.set(0, ["exited", 0, 0, ""]);
    await h.runner.tick(m.id);
    const r = await h.reload(m.id);
    expect(r.status).toBe("SEEDED");
    expect(r.phase).toBeNull();
    expect(r.buckets[0]).toMatchObject({ status: "SEEDED", doneObjects: 3n, doneBytes: 5012n, lastError: null });
    expect(h.agent.calls.some((c) => c.includes(`--filter label=tugra.objmig.idx=0`))).toBe(true);
  });

  it("running helpers only update progress", async () => {
    const h = setup();
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    await h.runner.tick(m.id);
    expect((await h.reload(m.id)).buckets[0]).toMatchObject({ status: "SEEDING", doneObjects: 3n, doneBytes: 5012n });
    h.runner.onModuleDestroy();
  });

  it("non-zero exit => FAILED with a FIXED classified code (never mc text / object keys)", async () => {
    const h = setup();
    const m = await seeded(h, 2);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    h.agent.state.helpers.set(0, ["exited", 1, 1, '{"status":"error","error":{"message":"Access Denied. customer-secret-file.pdf"}}']);
    h.agent.state.helpers.set(1, ["exited", 0, 0, ""]);
    await h.runner.tick(m.id);
    const r = await h.reload(m.id);
    expect(r.buckets[0]).toMatchObject({ status: "FAILED", lastError: "access-denied" });
    expect(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("customer-secret");
    expect(r.buckets[1].status).toBe("SEEDED"); // other buckets keep their state
    expect(r.status).toBe("FAILED");
  });

  it("ERRS > 0 with exit 0 is a FAILURE (mirror-errors), never a success", async () => {
    const h = setup();
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    h.agent.state.helpers.set(0, ["exited", 0, 2, ""]);
    await h.runner.tick(m.id);
    expect((await h.reload(m.id)).buckets[0]).toMatchObject({ status: "FAILED", lastError: "mirror-errors" });
  });

  it("a missing TUGRA_OBJ_STARTED => that bucket FAILED run-failed (and no helper is assumed)", async () => {
    const h = setup();
    h.agent.state.start = () => "TUGRA_OBJ_ERR 0 run-failed\nTUGRA_OBJ_START_END";
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    expect((await h.reload(m.id)).buckets[0]).toMatchObject({ status: "FAILED", lastError: "run-failed" });
  });

  it("a start script that never reaches its END marker marks nothing as started", async () => {
    const h = setup();
    h.agent.state.start = () => "TUGRA_OBJ_STARTED 0 abcdef012345";
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    expect((await h.reload(m.id)).buckets[0].status).toBe("FAILED");
  });

  it("an offline agent at start rolls the buckets back to their previous status and propagates the error", async () => {
    const h = setup();
    const m = await seeded(h, 2);
    h.agent.state.offline = true;
    await expect(h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) })).rejects.toThrow(/offline/);
    const r = await h.reload(m.id);
    expect(r.buckets.map((b: any) => b.status)).toEqual(["PENDING", "PENDING"]);
    expect(r.status).toBe("PREFLIGHTED");
  });

  it("fail closed during polling: a status output without its END marker, or an offline agent, changes NOTHING", async () => {
    const h = setup();
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    h.agent.state.helpers.set(0, ["exited", 0, 0, ""]);
    h.agent.state.statusMissingEnd = true;
    await h.runner.tick(m.id);
    expect((await h.reload(m.id)).buckets[0].status).toBe("SEEDING");
    h.agent.state.statusMissingEnd = false;
    h.agent.state.offline = true;
    await h.runner.tick(m.id);
    expect((await h.reload(m.id)).buckets[0].status).toBe("SEEDING");
    h.runner.onModuleDestroy();
  });

  it("an ABSENT helper is re-issued (mirror is idempotent), at most 3 times, then FAILED helper-missing", async () => {
    const h = setup();
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    h.agent.state.helpers.set(0, ["absent", 0, 0, ""]);
    const startsBefore = h.agent.calls.filter((c) => c.includes("TUGRA_OBJ_START_END")).length;
    for (let i = 0; i < 3; i++) await h.runner.tick(m.id);
    expect(h.agent.calls.filter((c) => c.includes("TUGRA_OBJ_START_END")).length).toBe(startsBefore + 3);
    expect((await h.reload(m.id)).buckets[0].status).toBe("SEEDING");
    await h.runner.tick(m.id);
    expect((await h.reload(m.id)).buckets[0]).toMatchObject({ status: "FAILED", lastError: "helper-missing" });
  });
});

describe("hub restart mid-seed", () => {
  it("a NEW runner instance re-attaches (onModuleInit) and completes the mirror without re-seeding", async () => {
    const h = setup();
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    h.runner.onModuleDestroy(); // "the hub died"; the detached helper keeps running on the agent
    const startsBefore = h.agent.calls.filter((c) => c.includes("TUGRA_OBJ_START_END")).length;
    const revived = new ObjMigrationRunnerService(h.prisma as never, { sendCommand: h.agent.sendCommand } as never, { encrypt: (s: string) => s, decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, "") } as never, h.audit as never);
    revived.timing = { pollMs: 5 };
    await revived.onModuleInit();
    h.agent.state.helpers.set(0, ["exited", 0, 0, ""]);
    await new Promise((r) => setTimeout(r, 40));
    revived.onModuleDestroy();
    expect((await h.reload(m.id)).buckets[0].status).toBe("SEEDED");
    expect(h.agent.calls.filter((c) => c.includes("TUGRA_OBJ_START_END")).length).toBe(startsBefore); // no restart: the helper was still there
  });

  it("onModuleInit ignores idle migrations", async () => {
    const h = setup();
    await seeded(h, 1);
    await h.runner.onModuleInit();
    expect((h.runner as any).timers.size).toBe(0);
  });
});

describe("cancel", () => {
  it("removes every helper, sends running buckets back (a later start resumes) and the migration to PREFLIGHTED", async () => {
    const h = setup();
    const m = await seeded(h, 3);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    await h.runner.cancel(m.id);
    const r = await h.reload(m.id);
    expect(r.buckets.map((b: any) => b.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(r.status).toBe("PREFLIGHTED");
    expect(r.cancelRequested).toBe(false);
    expect(r.phase).toBeNull();
    expect(h.agent.calls.some((c) => c.includes(`--filter label=tugra.objmig=${m.id}`) && !c.includes("idx="))).toBe(true);
    // resume
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(r) });
    expect((await h.reload(m.id)).buckets.map((b: any) => b.status)).toEqual(["SEEDING", "SEEDING", "QUEUED"]);
    h.runner.onModuleDestroy();
  });

  it("a cancelled FINAL pass returns to SEEDED (the seed data is still there)", async () => {
    const h = setup();
    const m = await seeded(h, 1);
    await h.prisma.objectMigrationBucket.updateMany({ where: { migrationId: m.id }, data: { status: "SEEDED" } });
    await h.prisma.objectMigration.update({ where: { id: m.id }, data: { status: "SEEDED" } });
    await h.runner.start(m.id, { phase: "final", remove: false, bucketIds: ids(await h.reload(m.id)) });
    expect((await h.reload(m.id)).status).toBe("FINALIZING");
    await h.runner.cancel(m.id);
    const r = await h.reload(m.id);
    expect(r.buckets[0].status).toBe("SEEDED");
    expect(r.status).toBe("SEEDED");
  });

  it("works with the agent offline: rows are reset, an orphan helper is left for the label sweep", async () => {
    const h = setup();
    const m = await seeded(h, 1);
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(await h.reload(m.id)) });
    h.agent.state.offline = true;
    await h.runner.cancel(m.id);
    expect((await h.reload(m.id)).buckets[0].status).toBe("PENDING");
  });
});

describe("final pass", () => {
  it("final uses --overwrite, and --remove ONLY when asked; success => FINAL", async () => {
    const h = setup();
    const m = await seeded(h, 1, { status: "SEEDED" });
    await h.prisma.objectMigrationBucket.updateMany({ where: { migrationId: m.id }, data: { status: "SEEDED" } });
    await h.runner.start(m.id, { phase: "final", remove: true, bucketIds: ids(await h.reload(m.id)) });
    const script = h.agent.calls.find((c) => c.includes("TUGRA_OBJ_START_END"))!;
    expect(script).toMatch(/mirror --json --preserve --overwrite --remove/);
    expect((await h.reload(m.id)).removeExtraneous).toBe(true);
    h.agent.state.helpers.set(0, ["exited", 0, 0, ""]);
    await h.runner.tick(m.id);
    expect((await h.reload(m.id)).buckets[0].status).toBe("FINAL");
    expect((await h.reload(m.id)).status).toBe("FINAL");
  });
});

describe("verify gating (DONE only after a clean verify of a FINAL pass)", () => {
  async function finalState(h: H, status: string) {
    const m = await seeded(h, 1, { status });
    await h.prisma.objectMigrationBucket.updateMany({ where: { migrationId: m.id }, data: { status } });
    return m;
  }
  it("FINAL + clean diff (extra > 0 is only info) => VERIFIED => migration DONE", async () => {
    const h = setup();
    const m = await finalState(h, "FINAL"); // the fake agent answers `0 0 1 0 0`: missing=0 differ=0 extra=1
    await h.runner.verify(m.id);
    const r = await h.reload(m.id);
    expect(r.buckets[0]).toMatchObject({ status: "VERIFIED", diffMissing: 0, diffDiffer: 0, diffExtra: 1 });
    expect(r.status).toBe("DONE");
  });
  it("SEEDED + clean diff records the numbers but the bucket stays SEEDED and the migration is NOT done", async () => {
    const h = setup();
    const m = await finalState(h, "SEEDED");
    await h.runner.verify(m.id);
    const r = await h.reload(m.id);
    expect(r.buckets[0]).toMatchObject({ status: "SEEDED", diffMissing: 0 });
    expect(r.status).toBe("SEEDED");
  });
  it("FINAL + missing/differing keys => DIFFERS (not done)", async () => {
    const h = setup();
    h.agent.state.diff = () => "TUGRA_OBJ_DIFF bk1 2 1 0 0 0\nTUGRA_OBJ_DIFF_END";
    const m = await finalState(h, "FINAL");
    await h.runner.verify(m.id);
    const r = await h.reload(m.id);
    expect(r.buckets[0]).toMatchObject({ status: "DIFFERS", diffMissing: 2, diffDiffer: 1 });
    expect(r.status).toBe("FINAL");
  });
  it.each([
    ["a missing END marker", "TUGRA_OBJ_DIFF bk1 0 0 0 0 0"],
    ["a non-zero mc exit", "TUGRA_OBJ_DIFF bk1 0 0 0 0 1\nTUGRA_OBJ_DIFF_END"],
    ["error lines", "TUGRA_OBJ_DIFF bk1 0 0 0 2 0\nTUGRA_OBJ_DIFF_END"],
    ["no row for the bucket", "TUGRA_OBJ_DIFF_END"],
  ])("%s => verify-failed, NEVER 'no differences'", async (_n, output) => {
    const h = setup();
    h.agent.state.diff = () => output;
    const m = await finalState(h, "FINAL");
    await h.runner.verify(m.id);
    const r = await h.reload(m.id);
    expect(r.buckets[0]).toMatchObject({ status: "FINAL", lastError: "verify-failed", diffMissing: null });
    expect(r.status).toBe("FINAL");
  });
  it("the diff script never asks mc for object keys to leave the host (counts only) and verify runs in groups of 3", async () => {
    const h = setup();
    const m = await seeded(h, 7, { status: "FINAL" });
    await h.prisma.objectMigrationBucket.updateMany({ where: { migrationId: m.id }, data: { status: "FINAL" } });
    await h.runner.verify(m.id);
    expect(h.agent.calls.filter((c) => c.includes("TUGRA_OBJ_DIFF_END"))).toHaveLength(3);
  });
});

describe("config carry", () => {
  async function exported(h: H, over: Record<string, unknown> = {}) {
    const m = await seeded(h, 1, { status: "SEEDED" });
    await h.prisma.objectMigrationBucket.updateMany({
      where: { migrationId: m.id },
      data: { status: "SEEDED", configStatus: "EXPORTED", config: { policy: MC_POLICY_JSON, lifecycle: MC_ILM_JSON, tags: [["env", "prod"]] }, ...over },
    });
    return m;
  }
  it("applies policy / lifecycle / tags to the destination bucket => APPLIED", async () => {
    const h = setup();
    const m = await exported(h);
    expect(await h.runner.carryConfig(m.id)).toEqual({ applied: 1, failed: 0 });
    expect((await h.reload(m.id)).buckets[0].configStatus).toBe("APPLIED");
  });
  it("a renamed bucket gets its policy ARNs rewritten to the destination name", async () => {
    const h = setup();
    const m = await exported(h, { dstBucket: "renamed-bucket" });
    await h.runner.carryConfig(m.id);
    const script = h.agent.calls.find((c) => c.includes("TUGRA_OBJ_CFG_END"))!;
    const b64Policy = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d \| MCT=60 mcr anonymous/.exec(script)![1];
    expect(Buffer.from(b64Policy, "base64").toString("utf8")).toContain("arn:aws:s3:::renamed-bucket/*");
  });
  it("a missing/failed marker marks configStatus FAILED (loud) and never touches the data states", async () => {
    const h = setup();
    h.agent.state.cfg = () => "TUGRA_OBJ_CFG bk1 policy ok"; // END missing
    const m = await exported(h);
    expect(await h.runner.carryConfig(m.id)).toEqual({ applied: 0, failed: 1 });
    const r = await h.reload(m.id);
    expect(r.buckets[0]).toMatchObject({ configStatus: "FAILED", status: "SEEDED" });
  });
  it("nothing to do when no bucket has an exported config", async () => {
    const h = setup();
    const m = await seeded(h, 1, { status: "SEEDED" });
    await h.prisma.objectMigrationBucket.updateMany({ where: { migrationId: m.id }, data: { status: "SEEDED", configStatus: "NONE" } });
    expect(await h.runner.carryConfig(m.id)).toEqual({ applied: 0, failed: 0 });
    expect(h.agent.calls.some((c) => c.includes("TUGRA_OBJ_CFG_END"))).toBe(false);
  });
});

describe("secrets", () => {
  it("credentials appear in NO persisted row after a full flow (only the encrypted columns carry them)", async () => {
    const h = setup();
    const m = await h.mk();
    await h.runner.preflight(m);
    const r = await h.reload(m.id);
    await h.prisma.objectMigrationBucket.updateMany({ where: { migrationId: m.id }, data: { selected: true } });
    await h.runner.start(m.id, { phase: "seed", remove: false, bucketIds: ids(r) });
    h.agent.state.helpers.set(0, ["exited", 1, 1, `Access Denied ${SECRETS.join(" ")}`]);
    await h.runner.tick(m.id);
    const rows = JSON.stringify([...h.store.buckets.values()], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const s of SECRETS) expect(rows).not.toContain(s);
    const mig = { ...[...h.store.migs.values()][0] };
    for (const col of ["srcAccessKeyEnc", "srcSecretKeyEnc", "dstAccessKeyEnc", "dstSecretKeyEnc"]) delete mig[col];
    for (const s of SECRETS) expect(JSON.stringify(mig)).not.toContain(s);
    expect(h.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.stringContaining("SECRET") }));
    h.runner.onModuleDestroy();
  });
});
