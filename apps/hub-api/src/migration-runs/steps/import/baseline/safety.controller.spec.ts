import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { RunSafetyController } from "./safety.controller";
import { SafetyHintsSchema, SetImagePinsSchema, SetWarningAcksSchema, SetWorkerMarksSchema } from "./hints.dto";
import { InMemoryRunHints } from "./run-hints";
import type { AuthUser } from "../../../../auth/strategies/jwt.strategy";

const D = `sha256:${"e".repeat(64)}`;
const user = (userId = "u1") => ({ userId, scopes: ["*"] }) as unknown as AuthUser;

function setup(run: Record<string, unknown> | null = {}, perms: string[] | null = ["apps:config", "databases"]) {
  const row = run === null ? null : { id: "r1", teamId: "t1", actorId: "u1", status: "WAITING", ponrAt: null, promotedFromId: null, ...run };
  const prisma = { migrationRun: { findUnique: jest.fn().mockResolvedValue(row) } };
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
    await expect(s.c.get(user(), "r1")).resolves.toEqual({ imagePins: [], workerMarks: [], warningAcks: [] });
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
    const { c, hints } = setup(done);
    const a = await c.setWarningAcks(user(), "r1", SetWarningAcksSchema.parse({ acks: [{ key: "import.risk-warning:service.image.floating", accepted: true }, { key: "data-seed.volume-excluded", accepted: true }] }));
    expect(a.warningAcks).toEqual(["data-seed.volume-excluded", "import.risk-warning:service.image.floating"]);
    expect(SafetyHintsSchema.parse(a)).toEqual(a);
    expect((await hints.list("r1")).every((h) => h.kind === "warning-ack" && h.value === "accepted" && h.evidence === "operator-attested")).toBe(true);
    const b = await c.setWarningAcks(user(), "r1", SetWarningAcksSchema.parse({ acks: [{ key: "data-seed.volume-excluded", accepted: false }] }));
    expect(b.warningAcks).toEqual(["import.risk-warning:service.image.floating"]);
  });

  it("is idempotent and keeps the pins and marks apart", async () => {
    const { c } = setup(done);
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
