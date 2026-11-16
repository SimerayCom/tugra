import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { PrismaRunStore } from "./run-store.prisma";
import { RunLeaseLostError } from "./run-contract";
import { ServerHasLiveRunError } from "./run-store";

const p2002 = (target: string) => new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x", meta: { target: [target] } });
const p2025 = () => new Prisma.PrismaClientKnownRequestError("nf", { code: "P2025", clientVersion: "x" });

function fake() {
  const run = { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() };
  const step = { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() };
  const event = { create: jest.fn(), findMany: jest.fn() };
  const prisma = { migrationRun: run, migrationRunStep: step, migrationRunEvent: event };
  return { prisma, run, step, event, store: new PrismaRunStore(prisma as never) };
}

const newRun = { teamId: "t", actorId: "u", targetServerId: "s", sourceKind: "coolify", sourceHost: "h", sessionId: "x", planHash: "p", mode: "copy", topology: "two-box", dryRun: false, promotedFromId: null, applyInput: { a: 1 }, options: {}, inputs: {}, activeKey: "srv:s" };

describe("PrismaRunStore", () => {
  it("creates the run with its step rows in ONE nested write and maps an activeKey clash to ServerHasLiveRunError", async () => {
    const { store, run } = fake();
    run.create.mockResolvedValue({ id: "r1" });
    await store.create(newRun, [{ key: "PREFLIGHT", idx: 0, kind: "auto", rollbackClass: "FREE" }], "QUEUED");
    expect(run.create).toHaveBeenCalledTimes(1);
    expect(run.create.mock.calls[0][0].data).toMatchObject({ status: "QUEUED", activeKey: "srv:s", steps: { create: [{ key: "PREFLIGHT", idx: 0, kind: "auto", rollbackClass: "FREE" }] } });
    run.create.mockRejectedValueOnce(p2002("activeKey"));
    await expect(store.create(newRun, [], "QUEUED")).rejects.toBeInstanceOf(ServerHasLiveRunError);
    run.create.mockRejectedValueOnce(p2002("somethingElse"));
    await expect(store.create(newRun, [], "QUEUED")).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("an OWNED run update guards on ownerId and raises RunLeaseLostError when it no longer holds; a plain CAS returns false", async () => {
    const { store, run } = fake();
    run.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(store.updateRun("r1", { bootId: "b1" }, { status: "WAITING" })).resolves.toBe(true);
    expect(run.updateMany.mock.calls[0][0].where).toEqual({ id: "r1", ownerId: "b1" });
    run.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(store.updateRun("r1", { bootId: "b1" }, { status: "WAITING" })).rejects.toBeInstanceOf(RunLeaseLostError);
    run.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(store.updateRun("r1", { statusIn: ["PAUSED"], ponrUnset: true }, { status: "RUNNING" })).resolves.toBe(false);
    expect(run.updateMany.mock.calls[2][0].where).toEqual({ id: "r1", status: { in: ["PAUSED"] }, ponrAt: null });
  });

  it("an owned write with a statusIn guard: a status miss on a lease that is still ours is false, a lost lease still raises", async () => {
    const { store, run } = fake();
    run.updateMany.mockResolvedValueOnce({ count: 0 });
    run.count.mockResolvedValueOnce(1); // ownerId still matches: an abort moved the status
    await expect(store.updateRun("r1", { bootId: "b1", statusIn: ["RUNNING", "WAITING"] }, { status: "PAUSED" })).resolves.toBe(false);
    expect(run.updateMany.mock.calls[0][0].where).toEqual({ id: "r1", ownerId: "b1", status: { in: ["RUNNING", "WAITING"] } });
    expect(run.count.mock.calls[0][0].where).toEqual({ id: "r1", ownerId: "b1" });
    run.updateMany.mockResolvedValueOnce({ count: 0 });
    run.count.mockResolvedValueOnce(0); // another boot owns it
    await expect(store.updateRun("r1", { bootId: "b1", statusIn: ["RUNNING", "WAITING"] }, { status: "PAUSED" })).rejects.toBeInstanceOf(RunLeaseLostError);
  });

  it("guards: ponrUnset=false means set, orphanOf selects unowned/foreign runs, activeKey clash maps to ServerHasLiveRunError", async () => {
    const { store, run } = fake();
    run.updateMany.mockResolvedValue({ count: 1 });
    await store.updateRun("r1", { ponrUnset: false, orphanOf: "b1" }, { status: "REVERSING" });
    expect(run.updateMany.mock.calls[0][0].where).toEqual({ id: "r1", ponrAt: { not: null }, OR: [{ ownerId: null }, { ownerId: { not: "b1" } }] });
    run.updateMany.mockRejectedValueOnce(p2002("activeKey"));
    await expect(store.updateRun("r1", { statusIn: ["ABORTED"] }, { status: "ROLLING_BACK", activeKey: "srv:s" })).rejects.toBeInstanceOf(ServerHasLiveRunError);
  });

  it("JSON columns: null clears (SQL NULL), values are stored, undefined is left out", async () => {
    const { store, run, step } = fake();
    run.updateMany.mockResolvedValue({ count: 1 });
    step.update.mockResolvedValue({});
    await store.updateRun("r1", {}, { windowEstimate: null, report: { a: 1 }, inputs: undefined, failureCode: "a.b" });
    const data = run.updateMany.mock.calls[0][0].data;
    expect(data.windowEstimate).toBe(Prisma.JsonNull);
    expect(data.report).toEqual({ a: 1 });
    expect("inputs" in data).toBe(false);
    expect(data.failureCode).toBe("a.b");
    run.count.mockResolvedValue(1);
    await store.updateStep("r1", "IMPORT", { gate: null, wait: { kind: "operator" }, status: "WAITING_OPERATOR", attempt: 2 }, "b1");
    expect(step.update.mock.calls[0][0]).toMatchObject({ where: { runId_key: { runId: "r1", key: "IMPORT" } }, data: { gate: Prisma.JsonNull, wait: { kind: "operator" }, status: "WAITING_OPERATOR", attempt: 2 } });
  });

  it("an owned step write checks the lease first and refuses once another boot owns the run", async () => {
    const { store, run, step } = fake();
    run.count.mockResolvedValue(0);
    await expect(store.updateStep("r1", "IMPORT", { attempt: 1 }, "b1")).rejects.toBeInstanceOf(RunLeaseLostError);
    expect(step.update).not.toHaveBeenCalled();
    expect(run.count).toHaveBeenCalledWith({ where: { id: "r1", ownerId: "b1" } });
  });

  it("updateStepIf is a compare-and-set on the step status", async () => {
    const { store, step } = fake();
    step.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await store.updateStepIf("r1", "IMPORT", ["FAILED"], { status: "RUNNING" })).toBe(true);
    expect(await store.updateStepIf("r1", "IMPORT", ["FAILED"], { status: "RUNNING" })).toBe(false);
    expect(step.updateMany.mock.calls[0][0].where).toEqual({ runId: "r1", key: "IMPORT", status: { in: ["FAILED"] } });
  });

  it("appendEvent allocates the seq atomically (increment-and-return) and writes the event under it; an owned append loses to another boot", async () => {
    const { store, run, event } = fake();
    run.update.mockResolvedValue({ eventSeq: 7 });
    event.create.mockResolvedValue({});
    expect(await store.appendEvent("r1", { stepKey: "IMPORT", level: "info", code: "a.b", params: { n: 1 }, actorId: null }, "b1")).toBe(7);
    expect(run.update.mock.calls[0][0]).toEqual({ where: { id: "r1", ownerId: "b1" }, data: { eventSeq: { increment: 1 } }, select: { eventSeq: true } });
    expect(event.create.mock.calls[0][0].data).toMatchObject({ runId: "r1", seq: 7, code: "a.b", params: { n: 1 }, stepKey: "IMPORT" });
    run.update.mockRejectedValueOnce(p2025());
    await expect(store.appendEvent("r1", { stepKey: null, level: "info", code: "a.b", params: null, actorId: null }, "b1")).rejects.toBeInstanceOf(RunLeaseLostError);
    run.update.mockResolvedValue({ eventSeq: 8 });
    await store.appendEvent("r1", { stepKey: null, level: "info", code: "a.b", params: null, actorId: "u1" });
    expect(run.update.mock.calls[2][0].where).toEqual({ id: "r1" });
    expect(event.create.mock.calls[1][0].data.params).toBe(Prisma.JsonNull);
  });

  it("setPonr applies only while the lease is ours and no abort was requested; otherwise it reports the existing instant or `abort`", async () => {
    const { store, run } = fake();
    const at = new Date("2026-11-23T08:00:00Z");
    run.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await store.setPonr("r1", "b1", at, "u1")).toBe(at);
    expect(run.updateMany.mock.calls[0][0].where).toEqual({ id: "r1", ownerId: "b1", ponrAt: null, abortRequested: false, status: { in: ["RUNNING", "WAITING"] } });
    run.updateMany.mockResolvedValueOnce({ count: 0 });
    run.findUnique.mockResolvedValueOnce({ ponrAt: at, ownerId: "b1", abortRequested: false, status: "RUNNING" });
    expect(await store.setPonr("r1", "b1", new Date(), "u1")).toBe(at);
    run.updateMany.mockResolvedValueOnce({ count: 0 });
    run.findUnique.mockResolvedValueOnce({ ponrAt: null, ownerId: "b1", abortRequested: true, status: "ABORTING" });
    expect(await store.setPonr("r1", "b1", new Date(), "u1")).toBe("abort");
    run.updateMany.mockResolvedValueOnce({ count: 0 });
    run.findUnique.mockResolvedValueOnce({ ponrAt: null, ownerId: "other", abortRequested: false, status: "RUNNING" });
    await expect(store.setPonr("r1", "b1", new Date(), "u1")).rejects.toBeInstanceOf(RunLeaseLostError);
  });

  it("claim takes the lease only from the owner it read and reports the previous owner (adoption)", async () => {
    const { store, run } = fake();
    run.findUnique.mockResolvedValueOnce({ ownerId: "dead", status: "RUNNING" });
    run.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await store.claim("r1", "b2", new Date(), ["RUNNING"])).toEqual({ claimed: true, previousOwner: "dead" });
    expect(run.updateMany.mock.calls[0][0].where).toEqual({ id: "r1", status: { in: ["RUNNING"] }, ownerId: "dead" });
    run.findUnique.mockResolvedValueOnce({ ownerId: null, status: "RUNNING" });
    run.updateMany.mockResolvedValueOnce({ count: 0 }); // lost the race
    expect((await store.claim("r1", "b2", new Date(), ["RUNNING"])).claimed).toBe(false);
    run.findUnique.mockResolvedValueOnce(null);
    expect(await store.claim("gone", "b2", new Date(), ["RUNNING"])).toEqual({ claimed: false, previousOwner: null });
  });

  it("list is scoped to the actor and their teams (a foreign teamId matches nothing); drivable/manual queries use the documented statuses", async () => {
    const { store, run, step } = fake();
    run.findMany.mockResolvedValue([]);
    await store.list({ actorId: "u1", teamIds: ["t1", "t2"], limit: 5 });
    expect(run.findMany.mock.calls[0][0].where).toEqual({ actorId: "u1", teamId: { in: ["t1", "t2"] } });
    await store.list({ actorId: "u1", teamIds: ["t1"], teamId: "t9", status: "COMPLETED", limit: 5 });
    expect(run.findMany.mock.calls[1][0].where).toMatchObject({ actorId: "u1", teamId: "\u0000none", status: "COMPLETED" });
    await store.list({ actorId: "u1", teamIds: ["t1"], live: true, limit: 5 });
    expect(run.findMany.mock.calls[2][0].where.status.in).toContain("FAILED");
    await store.drivable();
    expect(run.findMany.mock.calls[3][0].where).toEqual({ status: { in: ["RUNNING", "WAITING", "ABORTING", "ROLLING_BACK", "REVERSING"] } });
    step.findMany.mockResolvedValue([]);
    await store.manualInFlight();
    expect(step.findMany.mock.calls[0][0].where).toMatchObject({ key: "DECOMMISSION", run: { status: "COMPLETED" } });
    expect(await store.stepsOf([])).toEqual([]);
  });
});

/**
 * Structural proof behind "a dry-run writes nothing outside its own run rows": the engine, the service, the views and the
 * handlers never touch Prisma at all; the ONLY database writers of the run core are the run store (run tables) and the
 * import adapter (which wraps services a dry-run never calls with a mutating method).
 */
describe("the run core reaches the database only through its ports", () => {
  const root = join(__dirname, "..");
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  const runtimePrismaImport = /^import\s+(?!type\b)[^;]*from\s+"(?:@prisma\/client|[./]*\/prisma\/prisma\.service)"/m;

  it("engine, service, recovery, logic and views do not import Prisma at runtime", () => {
    for (const f of ["core/run-engine.service.ts", "core/migration-runs.service.ts", "core/run-recovery.service.ts", "core/run-logic.ts", "core/run-view.ts", "core/run-ports.ts", "core/run-store.ts"]) {
      expect({ f, prisma: runtimePrismaImport.test(read(f)) }).toEqual({ f, prisma: false });
    }
  });

  it("the four import-side handlers never import Prisma; only the adapter does, and it only READS through it", () => {
    for (const f of readdirSync(join(root, "steps/import")).filter((n) => n.endsWith(".step.ts"))) {
      expect({ f, prisma: /prisma/i.test(read(`steps/import/${f}`).replace(/import-ports|importer\//g, "")) }).toEqual({ f, prisma: false });
    }
    const adapter = read("steps/import/import-port.service.ts");
    const writes = adapter.match(/this\.prisma\.\w+\.(create|update|updateMany|upsert|delete|deleteMany)\b/g) ?? [];
    expect(writes).toEqual([]);
  });

  it("the store implementation writes only the three run tables", () => {
    const src = read("core/run-store.prisma.ts");
    const models = new Set([...src.matchAll(/this\.prisma\.(\w+)\./g)].map((m) => m[1]));
    expect([...models].sort()).toEqual(["migrationRun", "migrationRunEvent", "migrationRunStep"]);
  });
});
