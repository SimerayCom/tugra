import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { RunSafetyController } from "./safety.controller";
import { SafetyHintsSchema, SetImagePinsSchema, SetServicePinsSchema, SetWarningAcksSchema, SetWorkerMarksSchema } from "./hints.dto";
import { InMemoryRunHints } from "./run-hints";
import type { AuthUser } from "../../../../auth/strategies/jwt.strategy";

const D = `sha256:${"e".repeat(64)}`;
const user = (userId = "u1") => ({ userId, scopes: ["*"] }) as unknown as AuthUser;

/** The progress of a dry-run step that shows one warn item per key (`code:risk` for a risk warning), plus any ready-made items. */
const warnStep = (keys: string[], extra: Array<Record<string, unknown>> = []) => ({
  progress: { dryRun: [...keys.map((k) => (k.startsWith("import.risk-warning:") ? { code: "import.risk-warning", level: "warn", params: { risk: k.slice("import.risk-warning:".length) } } : { code: k, level: "warn" })), ...extra] },
});

function setup(run: Record<string, unknown> | null = {}, perms: string[] | null = ["apps:config", "databases"], steps: Array<{ progress: unknown }> = []) {
  const row = run === null ? null : { id: "r1", teamId: "t1", actorId: "u1", status: "WAITING", ponrAt: null, promotedFromId: null, ...run };
  const prisma = { migrationRun: { findUnique: jest.fn().mockResolvedValue(row) }, migrationRunStep: { findMany: jest.fn().mockResolvedValue(steps) } };
  const access = { membershipPermissions: jest.fn().mockResolvedValue(perms ? new Set(perms) : null) };
  const hints = new InMemoryRunHints();
  return { c: new RunSafetyController(prisma as never, access as never, hints), hints, prisma, access };
}

describe("RunSafetyController", () => {
  it("records and removes image pins, answering the whole set", async () => {
    const { c, hints } = setup();
    const a = await c.setPins(user(), "r1", SetImagePinsSchema.parse({ pins: [{ image: "getmeili/meilisearch:latest", scope: "src-a", digest: D, evidence: "host-loop-reported" }, { image: "x/y:latest", digest: D }] }));
    expect(a.imagePins).toEqual([
      { image: "getmeili/meilisearch:latest", scope: "src-a", digest: D, evidence: "host-loop-reported" },
      { image: "x/y:latest", scope: "", digest: D, evidence: "operator-attested" },
    ]);
    expect(SafetyHintsSchema.parse(a)).toEqual(a);
    const b = await c.setPins(user(), "r1", SetImagePinsSchema.parse({ pins: [{ image: "x/y:latest", digest: null }] }));
    expect(b.imagePins.map((p) => p.image)).toEqual(["getmeili/meilisearch:latest"]);
    expect((await hints.list("r1")).length).toBe(1);
  });

  it("records and removes job-runner marks", async () => {
    const { c } = setup();
    const a = await c.setMarks(user(), "r1", SetWorkerMarksSchema.parse({ marks: [{ itemRef: "app:s:q", role: "job-runner" }, { itemRef: "app:s:w", role: "web" }] }));
    expect(a.workerMarks).toEqual([{ itemRef: "app:s:q", role: "job-runner" }, { itemRef: "app:s:w", role: "web" }]);
    const b = await c.setMarks(user(), "r1", SetWorkerMarksSchema.parse({ marks: [{ itemRef: "app:s:q", role: null }] }));
    expect(b.workerMarks).toEqual([{ itemRef: "app:s:w", role: "web" }]);
  });

  it("a promoted run also shows its dry-run's hints", async () => {
    const { c, hints } = setup({ promotedFromId: "dry1" });
    await hints.upsert("dry1", [{ kind: "worker-mark", key: "app:s:q", scope: "", value: "job-runner", evidence: "operator-attested" }]);
    expect((await c.get(user(), "r1")).workerMarks).toHaveLength(1);
  });

  it("only the creator reaches a run: a missing run, someone else's run and a non-member are all 404", async () => {
    await expect(setup(null).c.get(user(), "r1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({ actorId: "other" }).c.get(user(), "r1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({}, null).c.get(user(), "r1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({ actorId: "other" }).c.setPins(user(), "r1", SetImagePinsSchema.parse({ pins: [{ image: "a:latest", digest: D }] }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it("writing needs the team permissions driving the run needs; reading needs membership only", async () => {
    const s = setup({}, ["apps:config"]);
    await expect(s.c.get(user(), "r1")).resolves.toEqual({ imagePins: [], workerMarks: [], warningAcks: [], servicePins: [], warningsFixed: [] });
    await expect(s.c.setMarks(user(), "r1", SetWorkerMarksSchema.parse({ marks: [{ itemRef: "app:s:q", role: "web" }] }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a run past the point of no return, or finished, takes no more hints", async () => {
    for (const run of [{ ponrAt: new Date() }, { status: "COMPLETED" }, { status: "ABORTED" }, { status: "REVERSED" }, { status: "ROLLED_BACK" }]) {
      await expect(setup(run).c.setPins(user(), "r1", SetImagePinsSchema.parse({ pins: [{ image: "a:latest", digest: D }] }))).rejects.toBeInstanceOf(ConflictException);
    }
    await expect(setup({ status: "DRY_RUN_DONE" }).c.setPins(user(), "r1", SetImagePinsSchema.parse({ pins: [{ image: "a:latest", digest: D }] }))).resolves.toBeDefined(); // a dry-run takes them for its promotion
  });
});

describe("RunSafetyController warning acks", () => {
  const done = { status: "DRY_RUN_DONE" };

  it("records, answers and takes back the warnings accepted on a finished dry-run", async () => {
    const { c, hints } = setup(done, undefined, [warnStep(["import.risk-warning:service.image.floating", "data-seed.volume-excluded"])]);
    const a = await c.setWarningAcks(user(), "r1", SetWarningAcksSchema.parse({ acks: [{ key: "import.risk-warning:service.image.floating", accepted: true }, { key: "data-seed.volume-excluded", accepted: true }] }));
    expect(a.warningAcks).toEqual(["data-seed.volume-excluded", "import.risk-warning:service.image.floating"]);
    expect(SafetyHintsSchema.parse(a)).toEqual(a);
    expect((await hints.list("r1")).every((h) => h.kind === "warning-ack" && h.value === "accepted" && h.evidence === "operator-attested")).toBe(true);
    const b = await c.setWarningAcks(user(), "r1", SetWarningAcksSchema.parse({ acks: [{ key: "data-seed.volume-excluded", accepted: false }] }));
    expect(b.warningAcks).toEqual(["import.risk-warning:service.image.floating"]);
  });

  it("is idempotent and keeps the pins and marks apart", async () => {
    const { c } = setup(done, undefined, [warnStep(["a.b"])]);
    await c.setMarks(user(), "r1", SetWorkerMarksSchema.parse({ marks: [{ itemRef: "app:s:q", role: "web" }] }));
    const body = SetWarningAcksSchema.parse({ acks: [{ key: "a.b", accepted: true }] });
    await c.setWarningAcks(user(), "r1", body);
    const r = await c.setWarningAcks(user(), "r1", body);
    expect(r.warningAcks).toEqual(["a.b"]);
    expect(r.workerMarks).toHaveLength(1);
  });

  it("a promoted run shows the acks of the dry-run it came from", async () => {
    const { c, hints } = setup({ promotedFromId: "dry1" });
    await hints.upsert("dry1", [{ kind: "warning-ack", key: "a.b", scope: "", value: "accepted", evidence: "operator-attested" }]);
    expect((await c.get(user(), "r1")).warningAcks).toEqual(["a.b"]);
  });

  it("only a finished dry-run takes them: every other state is a 409", async () => {
    for (const status of ["QUEUED", "RUNNING", "WAITING", "COMPLETED", "ABORTED", "FAILED"]) {
      await expect(setup({ status }).c.setWarningAcks(user(), "r1", SetWarningAcksSchema.parse({ acks: [{ key: "a.b", accepted: true }] }))).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it("keeps at most 200 accepted keys per run, however many calls it takes", async () => {
    const { c } = setup(done, undefined, [warnStep(Array.from({ length: 201 }, (_, i) => `a.k${i}`))]);
    const batch = (from: number, n: number) => SetWarningAcksSchema.parse({ acks: Array.from({ length: n }, (_, i) => ({ key: `a.k${from + i}`, accepted: true })) });
    await c.setWarningAcks(user(), "r1", batch(0, 200));
    await expect(c.setWarningAcks(user(), "r1", batch(200, 1))).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.setWarningAcks(user(), "r1", batch(0, 200))).resolves.toBeDefined(); // the same keys again change nothing
  });

  it("takes only a warning this dry run showed: another key is a 400, taking one back is always fine", async () => {
    const { c } = setup(done, undefined, [warnStep(["a.b"])]);
    await expect(c.setWarningAcks(user(), "r1", SetWarningAcksSchema.parse({ acks: [{ key: "x.y", accepted: true }] }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.setWarningAcks(user(), "r1", SetWarningAcksSchema.parse({ acks: [{ key: "x.y", accepted: false }] }))).resolves.toBeDefined();
  });

  it("is scoped to the creator and to team members who may drive the run", async () => {
    const body = SetWarningAcksSchema.parse({ acks: [{ key: "a.b", accepted: true }] });
    await expect(setup({ ...done, actorId: "other" }).c.setWarningAcks(user(), "r1", body)).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup(null).c.setWarningAcks(user(), "r1", body)).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup(done, null).c.setWarningAcks(user(), "r1", body)).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup(done, ["apps:config"]).c.setWarningAcks(user(), "r1", body)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the body takes only well-formed keys", () => {
    expect(SetWarningAcksSchema.safeParse({ acks: [] }).success).toBe(false);
    expect(SetWarningAcksSchema.safeParse({ acks: [{ key: "Bad Key", accepted: true }] }).success).toBe(false);
    expect(SetWarningAcksSchema.safeParse({ acks: [{ key: "a.b", accepted: true, x: 1 }] }).success).toBe(false);
    expect(SetWarningAcksSchema.safeParse({ acks: [{ key: "import.risk-warning:service.image.floating", accepted: false }] }).success).toBe(true);
    expect(SetWarningAcksSchema.safeParse({ acks: Array.from({ length: 201 }, (_, i) => ({ key: `a.k${i}`, accepted: true })) }).success).toBe(false);
  });
});

describe("RunSafetyController service pins", () => {
  const done = { status: "DRY_RUN_DONE" };
  const IT = "service:src-a:svc1";
  const floating = {
    code: "import.risk-warning",
    level: "warn",
    params: { risk: "service.image.floating", count: 1, imageCount: 2, imageItems: [IT, IT], imageMembers: ["meili", "web"], images: ["getmeili/meilisearch:latest", "ghcr.io/acme/web"], imageSeen: ["getmeili/meilisearch:v1.8.0", ""] },
  };
  const steps = [{ progress: { dryRun: [floating] } }];
  const body = (pins: Array<{ itemRef: string; member: string; ref: string | null }>) => SetServicePinsSchema.parse({ pins });

  it("pins a listed member to a version of its own repository, answers the whole set and marks what is fixed", async () => {
    const { c, hints } = setup(done, undefined, steps);
    const a = await c.setServicePins(user(), "r1", body([{ itemRef: IT, member: "meili", ref: "getmeili/meilisearch:v1.8.0" }]));
    expect(a.servicePins).toEqual([{ itemRef: IT, member: "meili", ref: "getmeili/meilisearch:v1.8.0", evidence: "source-api-reported" }]);
    expect(a.warningsFixed).toEqual([]); // the second image is still floating
    const b = await c.setServicePins(user(), "r1", body([{ itemRef: IT, member: "web", ref: `ghcr.io/acme/web@sha256:${"a".repeat(64)}` }]));
    expect(b.servicePins.find((p) => p.member === "web")?.evidence).toBe("operator-attested");
    expect(b.warningsFixed).toEqual(["import.risk-warning:service.image.floating"]);
    expect(SafetyHintsSchema.parse(b)).toEqual(b);
    const d = await c.setServicePins(user(), "r1", body([{ itemRef: IT, member: "web", ref: null }]));
    expect(d.servicePins).toHaveLength(1);
    expect(d.warningsFixed).toEqual([]);
    expect((await hints.list("r1")).filter((h) => h.kind === "service-pin")).toHaveLength(1);
  });

  it("refuses a member the dry run did not list, another repository, a floating ref and too many pins", async () => {
    const { c } = setup(done, undefined, steps);
    await expect(c.setServicePins(user(), "r1", body([{ itemRef: IT, member: "ghost", ref: "getmeili/meilisearch:v1" }]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.setServicePins(user(), "r1", body([{ itemRef: IT, member: "meili", ref: "evil/meilisearch:v1" }]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.setServicePins(user(), "r1", body([{ itemRef: IT, member: "meili", ref: "getmeili/meilisearch:latest" }]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.setServicePins(user(), "r1", body([{ itemRef: IT, member: "meili", ref: "getmeili/meilisearch" }]))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("only a finished dry-run takes pins, only for the creator who may drive the run", async () => {
    const b = body([{ itemRef: IT, member: "meili", ref: "getmeili/meilisearch:v1" }]);
    await expect(setup({ status: "WAITING" }, undefined, steps).c.setServicePins(user(), "r1", b)).rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ ...done, actorId: "other" }, undefined, steps).c.setServicePins(user(), "r1", b)).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup(done, ["apps:config"], steps).c.setServicePins(user(), "r1", b)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the body takes a service item, a compose key and a well-formed ref", () => {
    expect(SetServicePinsSchema.safeParse({ pins: [{ itemRef: "app:s:x", member: "m", ref: "a:b" }] }).success).toBe(false);
    expect(SetServicePinsSchema.safeParse({ pins: [{ itemRef: IT, member: "m m", ref: "a:b" }] }).success).toBe(false);
    expect(SetServicePinsSchema.safeParse({ pins: [{ itemRef: IT, member: "m", ref: "a b" }] }).success).toBe(false);
    expect(SetServicePinsSchema.safeParse({ pins: [{ itemRef: IT, member: "m", ref: "a:b", x: 1 }] }).success).toBe(false);
  });
});

describe("hints schemas", () => {
  it("accept only a sha256 digest, a plain image ref, a known role and known keys", () => {
    expect(SetImagePinsSchema.safeParse({ pins: [{ image: "a/b:latest", digest: "sha256:short" }] }).success).toBe(false);
    expect(SetImagePinsSchema.safeParse({ pins: [{ image: "a/b:latest", digest: D.toUpperCase() }] }).success).toBe(false);
    expect(SetImagePinsSchema.safeParse({ pins: [{ image: "a b", digest: D }] }).success).toBe(false);
    expect(SetImagePinsSchema.safeParse({ pins: [{ image: "-x", digest: D }] }).success).toBe(false);
    expect(SetImagePinsSchema.safeParse({ pins: [{ image: "a:b", digest: D, evidence: "source-api-reported" }] }).success).toBe(false);
    expect(SetImagePinsSchema.safeParse({ pins: [{ image: "a:b", digest: D, extra: 1 }] }).success).toBe(false);
    expect(SetImagePinsSchema.safeParse({ pins: [] }).success).toBe(false);
    expect(SetImagePinsSchema.safeParse({ pins: Array.from({ length: 501 }, () => ({ image: "a:b", digest: D })) }).success).toBe(false);
    expect(SetWorkerMarksSchema.safeParse({ marks: [{ itemRef: "app:s:q", role: "admin" }] }).success).toBe(false);
    expect(SetWorkerMarksSchema.safeParse({ marks: [{ itemRef: "", role: "web" }] }).success).toBe(false);
    expect(SetWorkerMarksSchema.safeParse({ marks: [{ itemRef: "app:s:q", role: "job-runner" }] }).success).toBe(true);
  });
});
