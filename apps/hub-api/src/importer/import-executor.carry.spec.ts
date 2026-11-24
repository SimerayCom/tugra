import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { ImportExecutorService } from "./import-executor.service";
import { foreignDbOfContainer } from "./sources/coolify-map";
import { foreignDbToCreateInput } from "./apply-map";

const CTR = "qrstuvwxyz0123456789abcd"; // a database container the source API does not list
const APPUUID = "aabbccddeeff00112233aabb";

type Task = { id: string; opId: string; itemRef: string | null; kind: string; status: string; resourceType: string | null; resourceId: string | null; result?: unknown; output?: string | null };

function harness(over: { meta?: Record<string, unknown>; tasks?: Task[]; permission?: boolean; createFails?: boolean; cancelled?: boolean; rows?: Array<{ id: string; name: string; tags: string[] }>; crashAfterInsert?: boolean } = {}) {
  const tasks: Task[] = over.tasks ?? [
    { id: "t-app", opId: "op-1", itemRef: `app:srv-a:${APPUUID}`, kind: "app", status: "DONE", resourceType: "application", resourceId: "app-1" },
  ];
  const op = { id: "op-1", kind: "import", actorId: "user-1", meta: { sourceKind: "coolify", serverId: "tgt-1", ...over.meta }, cancelRequestedAt: over.cancelled ? new Date() : null, tasks };
  let seq = 0;
  const prisma = {
    bulkTask: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async ({ data }: { data: Partial<Task> }) => {
        const t = { id: `t-${++seq}`, resourceType: null, resourceId: null, ...data } as Task;
        tasks.push(t);
        return t;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Task> }) => {
        const t = tasks.find((x) => x.id === where.id)!;
        Object.assign(t, data);
        return t;
      }),
    },
    bulkOperation: { findUnique: jest.fn(async () => op) },
    server: { findUnique: jest.fn(async () => ({ teamId: "team-1" })) },
    application: { findUnique: jest.fn(async () => ({ environmentId: "env-run" })) },
    database: { findUnique: jest.fn(async () => ({ environmentId: "env-run" })) },
  };
  const access = { requirePermission: over.permission === false ? jest.fn().mockRejectedValue(new ForbiddenException("denied")) : jest.fn().mockResolvedValue(undefined) };
  // the database rows that exist on the target (a row an earlier attempt inserted survives a crash of the process that made it)
  const rows: Array<{ id: string; name: string; tags: string[] }> = over.rows ?? [];
  const dbs = {
    createMarked: jest.fn(async (_u: string, input: { name: string }, marker: string) => {
      if (over.createFails) throw new Error("create refused");
      const row = { id: `db-new${rows.length ? `-${rows.length}` : ""}`, name: input.name, tags: [marker] };
      rows.push(row);
      if (over.crashAfterInsert) throw new Error("process died");
      return row;
    }),
    findMarked: jest.fn(async (_s: string, marker: string) => rows.find((r) => r.tags.includes(marker)) ?? null),
    dropMarker: jest.fn(async (id: string, marker: string) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.tags = r.tags.filter((t) => t !== marker);
    }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new ImportExecutorService(prisma as never, {} as never, access as never, audit as never, {} as never, {} as never, dbs as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { svc, prisma, tasks, access, dbs, audit, rows };
}

const db = () => foreignDbOfContainer({ host: "srv-a", container: CTR, engine: "POSTGRES", version: "17", image: "postgres:17-alpine", name: "unlisted-postgres-qrstuvwx", user: "appuser", database: "appdb" });

describe("foreignDbOfContainer / foreignDbToCreateInput (R2)", () => {
  it("the container name is the source reference and the host the server; only the non-secret identity is carried", () => {
    expect(db()).toEqual({ sourceRef: CTR, name: "unlisted-postgres-qrstuvwx", engine: "POSTGRES", version: "17", image: "postgres:17-alpine", credentials: { username: "appuser", database: "appdb" }, hostInternal: CTR, serverRef: "srv-a" });
    expect(foreignDbOfContainer({ host: "_", container: CTR, engine: "REDIS", version: "7", image: "redis:7", name: "n" }).serverRef).toBeUndefined();
    expect(JSON.stringify(db())).not.toMatch(/secretRef|password/i);
  });
  it("the create input is the engine and version on the given server: no image, no password", () => {
    expect(foreignDbToCreateInput(db(), { serverId: "tgt-1", environmentId: "env-run" })).toEqual({ name: "unlisted-postgres-qrstuvwx", serverId: "tgt-1", engine: "POSTGRES", version: "17", environmentId: "env-run" });
    expect(foreignDbToCreateInput(db(), { serverId: "tgt-1" })).not.toHaveProperty("environmentId");
  });
});

describe("ImportExecutorService.carryUnlistedDb (R2)", () => {
  it("creates the Tugra database and a finished database task for database:<host>:<container> in the run's environment", async () => {
    const { svc, dbs, tasks, audit, access } = harness();
    await expect(svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).resolves.toEqual({ itemRef: `database:srv-a:${CTR}`, created: true });
    expect(access.requirePermission).toHaveBeenCalledWith("user-1", "team-1", "databases");
    expect(dbs.createMarked).toHaveBeenCalledWith("user-1", { name: "unlisted-postgres-qrstuvwx", serverId: "tgt-1", engine: "POSTGRES", version: "17", environmentId: "env-run" }, expect.stringMatching(/^import-[0-9a-f]{24}$/));
    const t = tasks.find((x) => x.itemRef === `database:srv-a:${CTR}`)!;
    expect(t).toMatchObject({ kind: "database", status: "DONE", resourceType: "database", resourceId: "db-new", result: { name: "unlisted-postgres-qrstuvwx", databaseId: "db-new", carried: true, credentialsCarried: false } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.unlisted_db_carried", target: "op-1" }));
    expect(JSON.stringify([t, audit.log.mock.calls])).not.toMatch(/password|secret/i);
  });

  it("is idempotent: a finished item answers created:false and creates nothing; a failed attempt's task is reused", async () => {
    const done = harness({ tasks: [{ id: "t-x", opId: "op-1", itemRef: `database:srv-a:${CTR}`, kind: "database", status: "DONE", resourceType: "database", resourceId: "db-old" }] });
    await expect(done.svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).resolves.toEqual({ itemRef: `database:srv-a:${CTR}`, created: false });
    expect(done.dbs.createMarked).not.toHaveBeenCalled();

    const failed = harness({ createFails: true });
    await expect(failed.svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).rejects.toThrow("create refused");
    expect(failed.tasks.find((x) => x.itemRef === `database:srv-a:${CTR}`)).toMatchObject({ status: "FAILED", resourceId: null });
    failed.dbs.createMarked.mockResolvedValueOnce({ id: "db-new", name: "n", tags: [] });
    await expect(failed.svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).resolves.toMatchObject({ created: true });
    expect(failed.tasks.filter((x) => x.itemRef === `database:srv-a:${CTR}`)).toHaveLength(1); // the same task, not a second one
    expect(failed.tasks.find((x) => x.itemRef === `database:srv-a:${CTR}`)).toMatchObject({ status: "DONE", resourceId: "db-new" });
  });

  it("a crash between the insert and the task update leaves no second database: the retry adopts the row by its marker and strips it", async () => {
    const h = harness({ crashAfterInsert: true });
    await expect(h.svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).rejects.toThrow("process died");
    expect(h.rows).toHaveLength(1);
    expect(h.tasks.find((x) => x.itemRef === `database:srv-a:${CTR}`)).toMatchObject({ status: "FAILED", resourceId: null });
    // the process comes back (the stale RUNNING task was reaped to FAILED): the same op carries the same container again
    const again = harness({ rows: h.rows, tasks: h.tasks });
    await expect(again.svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).resolves.toEqual({ itemRef: `database:srv-a:${CTR}`, created: true });
    expect(again.dbs.createMarked).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(1);
    expect(h.tasks.find((x) => x.itemRef === `database:srv-a:${CTR}`)).toMatchObject({ status: "DONE", resourceType: "database", resourceId: h.rows[0].id });
    expect(h.rows[0].tags).toEqual([]);
    expect(again.audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ adopted: true }) }));
  });

  it("the marker is per op and item: another container of the same op, or the same container of another op, does not adopt the row", async () => {
    const h = harness({ crashAfterInsert: true });
    await expect(h.svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).rejects.toThrow();
    const other = harness({ rows: h.rows });
    await other.svc.carryUnlistedDb("user-1", "op-1", { ...db(), sourceRef: "other-ctr" }, "tgt-1");
    expect(other.dbs.createMarked).toHaveBeenCalledTimes(1);
    expect(h.rows).toHaveLength(2);
  });

  it("refuses an engine the migrator cannot dump, a non-Coolify op, a rolled-back or cancelled op, and a caller without the databases permission", async () => {
    const h = harness();
    await expect(h.svc.carryUnlistedDb("user-1", "op-1", { ...db(), engine: "LIBSQL" }, "tgt-1")).rejects.toBeInstanceOf(BadRequestException);
    await expect(harness({ meta: { sourceKind: "dokploy" } }).svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).rejects.toBeInstanceOf(ConflictException);
    await expect(harness({ meta: { rolledBackAt: "2026-11-20T10:00:00.000Z" } }).svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).rejects.toBeInstanceOf(ConflictException);
    await expect(harness({ cancelled: true }).svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).rejects.toBeInstanceOf(ConflictException);
    const denied = harness({ permission: false });
    await expect(denied.svc.carryUnlistedDb("user-1", "op-1", db(), "tgt-1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.dbs.createMarked).not.toHaveBeenCalled();
    expect(denied.tasks.some((x) => x.kind === "database")).toBe(false);
    await expect(harness().svc.carryUnlistedDb("someone-else", "op-1", db(), "tgt-1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});
