import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { RunSafetyController } from "./safety.controller";
import { SafetyHintsSchema, SetImagePinsSchema, SetWorkerMarksSchema } from "./hints.dto";
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
    await expect(s.c.get(user(), "r1")).resolves.toEqual({ imagePins: [], workerMarks: [] });
    await expect(s.c.setMarks(user(), "r1", SetWorkerMarksSchema.parse({ marks: [{ itemRef: "app:s:q", role: "web" }] }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a run past the point of no return, or finished, takes no more hints", async () => {
    for (const run of [{ ponrAt: new Date() }, { status: "COMPLETED" }, { status: "ABORTED" }, { status: "REVERSED" }, { status: "ROLLED_BACK" }]) {
      await expect(setup(run).c.setPins(user(), "r1", SetImagePinsSchema.parse({ pins: [{ image: "a:latest", digest: D }] }))).rejects.toBeInstanceOf(ConflictException);
    }
    await expect(setup({ status: "DRY_RUN_DONE" }).c.setPins(user(), "r1", SetImagePinsSchema.parse({ pins: [{ image: "a:latest", digest: D }] }))).resolves.toBeDefined(); // a dry-run takes them for its promotion
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
