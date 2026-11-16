import { Readable } from "node:stream";
import { BadRequestException, ConflictException, PayloadTooLargeException, UnsupportedMediaTypeException } from "@nestjs/common";
import type { MigrationTokenContext } from "../../../../importer/migration-token.service";
import { HostReportService, countBody, readTextBody } from "./host-report.service";
import { FakeHostReports } from "./testing/fake-host-reports";
import { decodeHostReports } from "./host-view";

const T = "\t";
const A = "a".repeat(64);
const at = (ref: string, ...f: string[]) => ["TUGRA_AT", ref, ...f].join(T);
const OP: MigrationTokenContext = { opId: "op1", actorId: "user1", expiresAt: new Date() } as MigrationTokenContext;

function build(over: { status?: string; actorId?: string; serverMap?: Record<string, string> | null } = {}) {
  const prisma = {
    migrationRun: { findUnique: jest.fn(async () => ({ id: "run1", actorId: over.actorId ?? "user1", status: over.status ?? "RUNNING", targetServerId: "srv-t", serverMap: over.serverMap ?? { "host-mapped": "srv-t2" } })) },
    server: { findUnique: jest.fn(async () => ({ teamId: "team1" })) },
    bulkTask: { findMany: jest.fn(async () => [{ itemRef: "database:host-1:dbuuid" }, { itemRef: "app:host-2:appuuid" }, { itemRef: "data:database:host-evil:dbuuid" }, { itemRef: null }]) },
  };
  const access = { requirePermission: jest.fn(async () => undefined) };
  const reports = new FakeHostReports();
  const svc = new HostReportService(prisma as never, access as never, reports);
  return { svc, prisma, access, reports };
}

const body = (...lines: string[]) => lines.join("\n");

describe("HostReportService.ingest", () => {
  it("stores loop, inventory, reach and freeze reports under the run of the token's op, for hosts of that run only", async () => {
    const { svc, reports, access } = build();
    const res = await svc.ingest(
      OP,
      body(
        at("host-1", "TUGRA_HOST", "DATA_SEED", "launched", "started", "-"),
        at("host-1", "TUGRA_HOST", "DATA_SEED", "finished", "ok", "0"),
        at("host-1", "TUGRA_INV", "ctr", A, "db", "postgres:16", "running"),
        at("host-1", "TUGRA_INV", "end", "1"),
        at("host-1", "TUGRA_REACH", "200", "128", "128", "-", "4"),
        at("host-mapped", "TUGRA_STOP", A, "stopped"),
        at("host-mapped", "TUGRA_FZ", "done"),
        at("host-evil", "TUGRA_HOST", "DATA_SEED", "finished", "ok", "0"), // not a host of this run
        at("host-evil", "TUGRA_INV", "end", "0"),
        at("_", "TUGRA_HOST", "INVENTORY", "finished", "ok", "0"), // the unknown host label is allowed
      ),
    );
    expect(access.requirePermission).toHaveBeenCalledWith("user1", "team1", "apps:config");
    expect(res.stored).toBe(6);
    expect(res.ignored).toBe(2);
    const view = decodeHostReports(await reports.list("run1"));
    expect(view.loop.map((l) => `${l.ref}:${l.step}:${l.state}`).sort()).toEqual(["_:INVENTORY:finished", "host-1:DATA_SEED:finished"]); // last wins per (step, host)
    expect(view.inventories.get("host-1")).toMatchObject({ complete: true, containers: [expect.objectContaining({ name: "db" })] });
    expect(view.reach.get("host-1")).toMatchObject({ pingCode: 200, maxPassedMiB: 128 });
    expect(view.freeze.get("host-mapped")).toMatchObject({ state: "stopped" }); // a mapped host (a serverMap key) is a host of the run
    expect([...view.inventories.keys(), ...view.reach.keys()]).not.toContain("host-evil");
  });

  it("a partial inventory never replaces a whole earlier one, and is stored when there is none", async () => {
    const { svc, reports } = build();
    await svc.ingest(OP, body(at("host-1", "TUGRA_INV", "ctr", A, "whole", "postgres:16", "running"), at("host-1", "TUGRA_INV", "end", "1")));
    const second = await svc.ingest(OP, body(at("host-1", "TUGRA_INV", "ctr", A, "cut-off", "postgres:16", "running"))); // no end marker
    expect(second).toEqual({ stored: 0, ignored: 1 });
    expect(decodeHostReports(await reports.list("run1")).inventories.get("host-1")!.containers[0].name).toBe("whole");

    const fresh = build();
    await fresh.svc.ingest(OP, body(at("host-2", "TUGRA_INV", "ctr", A, "only-partial", "postgres:16", "running")));
    const v = decodeHostReports(await fresh.reports.list("run1")).inventories.get("host-2")!;
    expect(v.complete).toBe(false);
  });

  it("merges a freeze and a later unfreeze of the same host into one report with the record kept", async () => {
    const { svc, reports } = build();
    await svc.ingest(
      OP,
      body(at("host-1", "TUGRA_FZ", "action", "freeze"), at("host-1", "TUGRA_CTR", "app:host-1:appuuid", A, "appuuid-170000000000", "ghcr.io/x:1", "", "running"), at("host-1", "TUGRA_STOP", A, "stopped"), at("host-1", "TUGRA_FZ", "done")),
    );
    expect(decodeHostReports(await reports.list("run1")).freeze.get("host-1")).toMatchObject({ state: "stopped" });
    await svc.ingest(OP, body(at("host-1", "TUGRA_FZ", "action", "unfreeze"), at("host-1", "TUGRA_START", A, "started"), at("host-1", "TUGRA_FZ", "done")));
    const f = decodeHostReports(await reports.list("run1")).freeze.get("host-1")!;
    expect(f.state).toBe("restarted");
    expect(f.payload.recorded.map((c) => c.id)).toEqual([A]);
  });

  it("a terminal run stores nothing and answers `ignored`, never an error (the script stays harmless)", async () => {
    const { svc, reports } = build({ status: "COMPLETED" });
    expect(await svc.ingest(OP, body(at("host-1", "TUGRA_HOST", "DATA_SEED", "finished", "ok", "0")))).toEqual({ stored: 0, ignored: 1 });
    expect(reports.rows).toEqual([]);
  });

  it("refuses an operation that belongs to another user, an empty body and an oversized one", async () => {
    await expect(build({ actorId: "someone-else" }).svc.ingest(OP, body(at("host-1", "TUGRA_HOST", "DATA_SEED", "finished", "ok", "0")))).rejects.toBeInstanceOf(ConflictException);
    await expect(build().svc.ingest(OP, "\n\n")).rejects.toBeInstanceOf(BadRequestException);
    await expect(build().svc.ingest(OP, "x".repeat(1024 * 1024 + 1))).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it("ping answers the hub's configured part size in MiB (the source tests the path with it)", () => {
    const keep = process.env.MIGRATION_VX_PART_MIB;
    process.env.MIGRATION_VX_PART_MIB = "64";
    try {
      expect(build().svc.ping()).toEqual({ ok: true, partMiB: 64 });
    } finally {
      if (keep === undefined) delete process.env.MIGRATION_VX_PART_MIB;
      else process.env.MIGRATION_VX_PART_MIB = keep;
    }
  });
});

const req = (chunks: Buffer[], headers: Record<string, string>) => Object.assign(Readable.from(chunks), { headers });

describe("raw body helpers", () => {
  it("readTextBody requires text/plain and enforces the cap both by header and by bytes", async () => {
    await expect(readTextBody(req([Buffer.from("x")], { "content-type": "application/json" }), 100)).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(readTextBody(req([Buffer.from("x")], { "content-type": "text/plain", "content-length": "101" }), 100)).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(readTextBody(req([Buffer.alloc(60), Buffer.alloc(60)], { "content-type": "text/plain" }), 100)).rejects.toBeInstanceOf(PayloadTooLargeException); // no content-length: counted
    expect(await readTextBody(req([Buffer.from("TUGRA"), Buffer.from("_AT")], { "content-type": "text/plain; charset=utf-8" }), 100)).toBe("TUGRA_AT");
  });

  it("countBody counts a raw upload without keeping it and refuses more than the cap", async () => {
    expect(await countBody(req([Buffer.alloc(10), Buffer.alloc(20)], {}), 100)).toBe(30);
    await expect(countBody(req([Buffer.alloc(60), Buffer.alloc(60)], {}), 100)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
