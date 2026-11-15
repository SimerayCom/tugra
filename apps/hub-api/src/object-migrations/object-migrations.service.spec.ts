/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ObjectMigrationsService, toObjectMigrationView } from "./object-migrations.service";
import { makeFakePrisma } from "./testing/fake-prisma";

const SECRETS = ["SRC-ACCESS-KEY-123", "SRC-SECRET-KEY-VALUE", "DST-ACCESS-KEY-456", "DST-SECRET-KEY-VALUE"];
const body = (over: Record<string, unknown> = {}) => ({
  name: "minio-move",
  targetServerId: "srv-1",
  preserve: true,
  source: { endpoint: "https://src.example.com:9000", accessKey: SECRETS[0], secretKey: SECRETS[1] },
  destination: { endpoint: "http://host.docker.internal:9100", accessKey: SECRETS[2], secretKey: SECRETS[3] },
  ...over,
});

function setup(opts: { member?: boolean; write?: boolean } = {}) {
  const { prisma, store } = makeFakePrisma();
  prisma.server.findUnique.mockImplementation(async ({ where }: any) => (where.id === "srv-1" ? { id: "srv-1", teamId: "team-1" } : where.id === "srv-x" ? { id: "srv-x", teamId: "team-other" } : null));
  const allow = opts.write !== false;
  const access = {
    requirePermission: jest.fn().mockImplementation(async (_u: string, team: string) => {
      if (!allow || team !== "team-1") throw new ForbiddenException("insufficient permission for this team");
    }),
    teamRole: jest.fn().mockImplementation(async (_u: string, team: string) => (opts.member === false || team !== "team-1" ? null : "OWNER")),
    membershipPermissions: jest.fn().mockResolvedValue(new Set(allow ? ["apps:config"] : [])),
    permissionsByTeam: jest.fn().mockResolvedValue(new Map([["team-1", new Set(allow ? ["apps:config"] : [])]])),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const crypto = { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s };
  const runner = {
    preflight: jest.fn().mockResolvedValue([]),
    start: jest.fn().mockResolvedValue(undefined),
    verify: jest.fn().mockResolvedValue(undefined),
    carryConfig: jest.fn().mockResolvedValue({ applied: 1, failed: 0 }),
    cancel: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
    refreshStatus: jest.fn().mockResolvedValue(null),
  };
  const svc = new ObjectMigrationsService(prisma as never, access as never, audit as never, crypto as never, runner as never);
  return { svc, prisma, store, access, audit, runner };
}
type H = ReturnType<typeof setup>;

async function created(h: H) {
  return h.svc.create("u1", body() as never);
}
const addBuckets = async (h: H, id: string, defs: Array<Record<string, unknown>>) => {
  for (const [i, d] of defs.entries()) await h.prisma.objectMigrationBucket.create({ data: { migrationId: id, idx: i, srcBucket: `bk${i + 1}`, dstBucket: `bk${i + 1}`, dstObjects: 0n, selected: true, ...d } });
};
const setStatus = (h: H, id: string, status: string) => h.prisma.objectMigration.update({ where: { id }, data: { status } });
const noSecrets = (v: unknown) => {
  const json = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  for (const s of SECRETS) expect(json).not.toContain(s);
};

describe("create", () => {
  it("encrypts all four credentials, stores normalised endpoints, and the view / audit never contain a credential", async () => {
    const h = setup();
    const v = await created(h);
    const row = [...h.store.migs.values()][0];
    expect(row).toMatchObject({ srcAccessKeyEnc: `enc(${SECRETS[0]})`, srcSecretKeyEnc: `enc(${SECRETS[1]})`, dstAccessKeyEnc: `enc(${SECRETS[2]})`, dstSecretKeyEnc: `enc(${SECRETS[3]})`, srcEndpoint: "https://src.example.com:9000", dstEndpoint: "http://host.docker.internal:9100", status: "DRAFT", teamId: "team-1", createdById: "u1" });
    noSecrets(v);
    noSecrets(h.audit.log.mock.calls);
    expect(Object.keys(v)).not.toEqual(expect.arrayContaining(["srcAccessKeyEnc", "srcSecretKeyEnc", "dstAccessKeyEnc", "dstSecretKeyEnc"]));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "object_migration.create", meta: expect.objectContaining({ srcEndpoint: "https://src.example.com:9000" }) }));
  });

  it("the target server's team needs apps:config; an unknown server is 404; a server of ANOTHER team is refused", async () => {
    await expect(setup({ write: false }).svc.create("u1", body() as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(setup().svc.create("u1", body({ targetServerId: "nope" }) as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup().svc.create("u1", body({ targetServerId: "srv-x" }) as never)).rejects.toBeInstanceOf(ForbiddenException); // cross-server / cross-team denial
  });

  it("rejects an unsafe endpoint even if the DTO was bypassed, and a source equal to the destination", async () => {
    await expect(setup().svc.create("u1", body({ source: { endpoint: "http://169.254.169.254", accessKey: "a", secretKey: "b" } }) as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup().svc.create("u1", body({ destination: { endpoint: "https://src.example.com:9000", accessKey: "a", secretKey: "b" } }) as never)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("read access", () => {
  it("get/list need membership; cross-team is denied; canWrite follows apps:config", async () => {
    const h = setup();
    const v = await created(h);
    expect((await h.svc.get("u1", v.id)).canWrite).toBe(true);
    const h2 = setup({ member: false });
    const m = await h2.prisma.objectMigration.create({ data: { teamId: "team-1", createdById: "u", name: "x", targetServerId: "srv-1", srcEndpoint: "a", dstEndpoint: "b", srcAccessKeyEnc: "e", srcSecretKeyEnc: "e", dstAccessKeyEnc: "e", dstSecretKeyEnc: "e" } });
    await expect(h2.svc.get("u1", m.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.svc.get("u1", "missing")).rejects.toBeInstanceOf(NotFoundException);
    const listed = await h.svc.list("u1");
    expect(listed).toHaveLength(1);
    await expect(h.svc.list("u1", "team-other")).rejects.toBeInstanceOf(ForbiddenException);
    noSecrets(listed);
  });
});

describe("preflight / setBuckets", () => {
  it("preflight delegates to the runner and audits only fixed codes", async () => {
    const h = setup();
    const v = await created(h);
    h.runner.preflight.mockResolvedValue([{ code: "src_unreachable", level: "blocker" }]);
    await h.svc.preflight("u1", v.id);
    expect(h.runner.preflight).toHaveBeenCalledTimes(1);
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "object_migration.preflight", meta: expect.objectContaining({ blockers: ["src_unreachable"] }) }));
    noSecrets(h.audit.log.mock.calls);
  });

  it("preflight is refused while a helper is running", async () => {
    const h = setup();
    const v = await created(h);
    await addBuckets(h, v.id, [{ status: "SEEDING" }]);
    await expect(h.svc.preflight("u1", v.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("setBuckets: needs preflight first; selection, rename and excludes are stored; NOTHING is pre-selected by default", async () => {
    const h = setup();
    const v = await created(h);
    await expect(h.svc.setBuckets("u1", v.id, { buckets: [] })).rejects.toBeInstanceOf(ConflictException); // DRAFT
    await setStatus(h, v.id, "PREFLIGHTED");
    await addBuckets(h, v.id, [{ selected: false }, { selected: false }]);
    const out = await h.svc.setBuckets("u1", v.id, { buckets: [{ srcBucket: "bk1", selected: true, dstBucket: "bk1-new", exclude: ["tmp/*"] }] });
    const b = Object.fromEntries(out.buckets.map((x) => [x.srcBucket, x]));
    expect(b.bk1).toMatchObject({ selected: true, dstBucket: "bk1-new", exclude: ["tmp/*"] });
    expect(b.bk2.selected).toBe(false);
  });

  it("setBuckets: unknown source bucket, two buckets into one destination, and a rename that resets the measured destination", async () => {
    const h = setup();
    const v = await created(h);
    await setStatus(h, v.id, "PREFLIGHTED");
    await addBuckets(h, v.id, [{ dstObjects: 5n, selected: false }, { selected: false }]);
    await expect(h.svc.setBuckets("u1", v.id, { buckets: [{ srcBucket: "ghost", selected: true }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.setBuckets("u1", v.id, { buckets: [{ srcBucket: "bk1", selected: true, dstBucket: "same-one" }, { srcBucket: "bk2", selected: true, dstBucket: "same-one" }] })).rejects.toBeInstanceOf(BadRequestException);
    await h.svc.setBuckets("u1", v.id, { buckets: [{ srcBucket: "bk1", selected: true, dstBucket: "renamed" }] });
    const row = [...h.store.buckets.values()].find((b) => b.srcBucket === "bk1")!;
    expect(row.dstObjects).toBeNull();
  });

  it("setBuckets is refused while helpers run", async () => {
    const h = setup();
    const v = await created(h);
    await setStatus(h, v.id, "SEEDING");
    await addBuckets(h, v.id, [{ status: "SEEDING" }]);
    await expect(h.svc.setBuckets("u1", v.id, { buckets: [{ srcBucket: "bk1", selected: false }] })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("start state machine + acknowledgements", () => {
  async function ready(h: H, status = "PREFLIGHTED", defs: Array<Record<string, unknown>> = [{}, {}]) {
    const v = await created(h);
    await setStatus(h, v.id, status);
    await addBuckets(h, v.id, defs);
    return v.id;
  }

  it("DRAFT cannot start; nothing selected is refused", async () => {
    const h = setup();
    const v = await created(h);
    await expect(h.svc.start("u1", v.id, { phase: "seed" })).rejects.toBeInstanceOf(ConflictException);
    const id = await ready(h, "PREFLIGHTED", [{ selected: false }]);
    await expect(h.svc.start("u1", id, { phase: "seed" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("seed hands the selected bucket ids to the runner, phase seed, no remove", async () => {
    const h = setup();
    const id = await ready(h, "PREFLIGHTED", [{}, { selected: false }]);
    await h.svc.start("u1", id, { phase: "seed" });
    const call = h.runner.start.mock.calls[0];
    expect(call[0]).toBe(id);
    expect(call[1]).toMatchObject({ phase: "seed", remove: false });
    expect(call[1].bucketIds).toHaveLength(1);
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "object_migration.start" }));
  });

  it("seed refuses removeExtraneous; seed is not allowed from FINAL/DONE", async () => {
    const h = setup();
    const id = await ready(h);
    await expect(h.svc.start("u1", id, { phase: "seed", removeExtraneous: true })).rejects.toBeInstanceOf(BadRequestException);
    await setStatus(h, id, "FINAL");
    await expect(h.svc.start("u1", id, { phase: "seed" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("FINAL requires acknowledgeWritesFrozen === true (absent or false is refused) and a completed seed", async () => {
    const h = setup();
    const id = await ready(h, "SEEDED", [{ status: "SEEDED" }]);
    await expect(h.svc.start("u1", id, { phase: "final" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.start("u1", id, { phase: "final", acknowledgeWritesFrozen: false })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.runner.start).not.toHaveBeenCalled();
    await h.svc.start("u1", id, { phase: "final", acknowledgeWritesFrozen: true });
    expect(h.runner.start.mock.calls[0][1]).toMatchObject({ phase: "final", remove: false });
    const h2 = setup();
    const id2 = await ready(h2, "PREFLIGHTED");
    await expect(h2.svc.start("u1", id2, { phase: "final", acknowledgeWritesFrozen: true })).rejects.toBeInstanceOf(ConflictException);
  });

  it("--remove is OFF unless explicitly acknowledged in the final request (and is audited)", async () => {
    const h = setup();
    const id = await ready(h, "SEEDED", [{ status: "SEEDED" }]);
    await h.svc.start("u1", id, { phase: "final", acknowledgeWritesFrozen: true, removeExtraneous: true });
    expect(h.runner.start.mock.calls[0][1].remove).toBe(true);
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "object_migration.final", meta: expect.objectContaining({ removeExtraneous: true }) }));
  });

  it("a non-empty destination bucket needs mergeIntoExisting; with it the ack is remembered", async () => {
    const h = setup();
    const id = await ready(h, "PREFLIGHTED", [{ dstObjects: 7n }]);
    await expect(h.svc.start("u1", id, { phase: "seed" })).rejects.toBeInstanceOf(BadRequestException);
    await h.svc.start("u1", id, { phase: "seed", mergeIntoExisting: true });
    expect([...h.store.migs.values()][0].mergeIntoExisting).toBe(true);
  });

  it("our own partial copy in a bucket we already started does NOT demand the merge ack again", async () => {
    const h = setup();
    const id = await ready(h, "FAILED", [{ status: "FAILED", dstObjects: 9n }]);
    await h.svc.start("u1", id, { phase: "seed" });
    expect(h.runner.start).toHaveBeenCalled();
  });

  it("an unmeasured destination (renamed since preflight) forces a fresh preflight", async () => {
    const h = setup();
    const id = await ready(h, "PREFLIGHTED", [{ dstObjects: null }]);
    await expect(h.svc.start("u1", id, { phase: "seed" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("one active migration per (target server, source bucket, destination bucket)", async () => {
    const h = setup();
    const a = await ready(h, "PREFLIGHTED", [{ status: "SEEDING" }]);
    expect(a).toBeTruthy();
    const b = await ready(h, "PREFLIGHTED", [{}]);
    await expect(h.svc.start("u1", b, { phase: "seed" })).rejects.toBeInstanceOf(ConflictException);
    expect(h.runner.start).not.toHaveBeenCalled();
  });

  it("start is refused while a helper of this migration is live", async () => {
    const h = setup();
    const id = await ready(h, "SEEDING", [{ status: "SEEDING" }]);
    await expect(h.svc.start("u1", id, { phase: "seed" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("a team without apps:config cannot start", async () => {
    const h = setup();
    const id = await ready(h);
    h.access.requirePermission.mockRejectedValue(new ForbiddenException("no"));
    await expect(h.svc.start("u1", id, { phase: "seed" })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("verify / carry-config / cancel / delete", () => {
  it("verify runs from SEEDED or FINAL only, and needs a seeded bucket", async () => {
    const h = setup();
    const v = await created(h);
    await addBuckets(h, v.id, [{ status: "SEEDED" }]);
    await expect(h.svc.verify("u1", v.id)).rejects.toBeInstanceOf(ConflictException); // DRAFT
    await setStatus(h, v.id, "SEEDED");
    await h.svc.verify("u1", v.id);
    expect(h.runner.verify).toHaveBeenCalledWith(v.id);
    const h2 = setup();
    const w = await created(h2);
    await setStatus(h2, w.id, "FINAL");
    await expect(h2.svc.verify("u1", w.id)).rejects.toBeInstanceOf(ConflictException); // no buckets
  });

  it("carry-config only after the data has been copied; verify/carry are refused mid-run", async () => {
    const h = setup();
    const v = await created(h);
    await setStatus(h, v.id, "PREFLIGHTED");
    await expect(h.svc.carryConfig("u1", v.id)).rejects.toBeInstanceOf(ConflictException);
    await setStatus(h, v.id, "SEEDED");
    await h.svc.carryConfig("u1", v.id);
    expect(h.runner.carryConfig).toHaveBeenCalledWith(v.id);
    await addBuckets(h, v.id, [{ status: "SEEDING" }]);
    await expect(h.svc.verify("u1", v.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(h.svc.carryConfig("u1", v.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("cancel needs something running", async () => {
    const h = setup();
    const v = await created(h);
    await expect(h.svc.cancel("u1", v.id)).rejects.toBeInstanceOf(ConflictException);
    await addBuckets(h, v.id, [{ status: "QUEUED" }]);
    await h.svc.cancel("u1", v.id);
    expect(h.runner.cancel).toHaveBeenCalledWith(v.id);
  });

  it("delete is blocked while a helper is live; otherwise it cleans up and wipes the row (and its encrypted credentials)", async () => {
    const h = setup();
    const v = await created(h);
    await addBuckets(h, v.id, [{ status: "SEEDING" }]);
    await expect(h.svc.remove("u1", v.id)).rejects.toBeInstanceOf(ConflictException);
    await h.prisma.objectMigrationBucket.updateMany({ where: { migrationId: v.id }, data: { status: "SEEDED" } });
    await expect(h.svc.remove("u1", v.id)).resolves.toEqual({ ok: true });
    expect(h.runner.cleanup).toHaveBeenCalled();
    expect(h.store.migs.size).toBe(0);
    expect(h.store.buckets.size).toBe(0);
  });

  it("every mutation is team-scoped: a denied permission stops it before the runner is touched", async () => {
    const h = setup();
    const v = await created(h);
    h.access.requirePermission.mockRejectedValue(new ForbiddenException("no"));
    for (const call of [() => h.svc.preflight("u2", v.id), () => h.svc.setBuckets("u2", v.id, { buckets: [] }), () => h.svc.start("u2", v.id, { phase: "seed" }), () => h.svc.verify("u2", v.id), () => h.svc.carryConfig("u2", v.id), () => h.svc.cancel("u2", v.id), () => h.svc.remove("u2", v.id)]) {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    }
    for (const fn of Object.values(h.runner)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("view", () => {
  it("BigInt counters become numbers, config is summarised by presence only, and no secret column leaks", () => {
    const m: any = {
      id: "m", name: "n", teamId: "t", targetServerId: "s", status: "PREFLIGHTED", phase: null, srcEndpoint: "https://a", dstEndpoint: "https://b",
      srcAccessKeyEnc: "enc(S1)", srcSecretKeyEnc: "enc(S2)", dstAccessKeyEnc: "enc(S3)", dstSecretKeyEnc: "enc(S4)",
      preserve: true, removeExtraneous: false, mergeIntoExisting: false, cancelRequested: false, warnings: [{ code: "x", level: "warn" }], createdAt: new Date(), updatedAt: new Date(), finishedAt: null,
      buckets: [{ idx: 1, srcBucket: "b2", dstBucket: "b2", exclude: [], selected: false, status: "PENDING", srcObjects: 5n, srcBytes: 9007199254n, dstObjects: null, dstBytes: null, doneObjects: null, doneBytes: null, diffMissing: null, diffDiffer: null, diffExtra: null, versioning: "enabled", config: { policy: '{"secret-looking":"POLICYBODY"}', lifecycle: null, tags: [["a", "b"]] }, configStatus: "EXPORTED", lastError: null, startedAt: null, finishedAt: null },
             { idx: 0, srcBucket: "b1", dstBucket: "b1", exclude: [], selected: true, status: "PENDING", srcObjects: null, srcBytes: null, dstObjects: null, dstBytes: null, doneObjects: null, doneBytes: null, diffMissing: null, diffDiffer: null, diffExtra: null, versioning: null, config: null, configStatus: null, lastError: null, startedAt: null, finishedAt: null }],
    };
    const v = toObjectMigrationView(m, true);
    expect(v.buckets.map((b) => b.srcBucket)).toEqual(["b1", "b2"]);
    expect(v.buckets[1]).toMatchObject({ srcObjects: 5, srcBytes: 9007199254, configSummary: { policy: true, lifecycle: false, tags: true } });
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/enc\(|POLICYBODY|Enc"/);
    expect(v.buckets[0].configSummary).toBeNull();
  });
});
