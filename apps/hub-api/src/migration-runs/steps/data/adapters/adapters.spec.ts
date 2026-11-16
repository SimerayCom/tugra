import { ForbiddenException } from "@nestjs/common";
import { ControlError, CoolifyControl, type CoolifyControlTransport } from "../../../../importer/sources/coolify-control";
import { DataPortError } from "../data-contract";
import { makeRun } from "../testing/fakes";
import { ServerCapabilityPort } from "./capability.adapter";
import { PrismaDataPort } from "./data-port.adapter";
import { TargetDbStats } from "./db-stats.adapter";
import { ImporterDrift } from "./drift.adapter";
import { CutoverFlipPlans } from "./flip-plan.adapter";
import { ObjectMigrationPort } from "./object-port.adapter";
import { PrismaRuntime } from "./runtime.adapter";
import { CoolifySourceApi } from "./source-api.adapter";
import { AgentSourceHost } from "./source-host.adapter";

/** A prisma stand-in that refuses every write: a read-only adapter method must not trip it. */
const readOnly = (reads: Record<string, Record<string, unknown>>) =>
  new Proxy(reads, {
    get(target, model: string) {
      const m = target[model] ?? {};
      return new Proxy(m, {
        get(mm, method: string) {
          if (method in mm) return mm[method];
          if (/^(create|update|upsert|delete)/.test(method)) return () => Promise.reject(new Error(`a read-only adapter wrote: ${model}.${method}`));
          return () => Promise.reject(new Error(`unexpected read: ${model}.${method}`));
        },
      });
    },
  }) as never;

const NOW = Date.now();
const task = (o: Record<string, unknown>) => ({ opId: "op1", serverId: "s", status: "DONE", exitCode: null, output: null, kind: "app", itemRef: null, resourceType: null, resourceId: null, result: null, steps: null, dependsOn: [], compensation: null, startedAt: null, finishedAt: null, ...o });

describe("PrismaDataPort.snapshot", () => {
  const op = (over: Record<string, unknown> = {}) => ({
    id: "op1",
    kind: "import",
    actorId: "user1",
    cancelRequestedAt: null,
    migrationTokenHash: "hash",
    migrationTokenExpiresAt: new Date(NOW + 3600_000),
    meta: {
      serverId: "srv-target",
      hubBase: "https://hub.example.com",
      plan: { items: [{ itemRef: "database:s:pgvol", kind: "database", proposed: { dataMode: "volume" } }] },
      vxInventory: { "volume:s:abc:data": { found: true, rawBytes: 100, entries: 7, running: true, mountType: "volume", runId: "r" } },
      vxDisk: { "volume:s:abc:data": { ok: true, unknown: false } },
      vxExcluded: { "volume:s:ex:cache": { reason: "r", at: "t", by: "u" } },
    },
    tasks: [
      task({ itemRef: "app:s:abc", kind: "app", resourceType: "application", resourceId: "app1", result: { volumes: { declared: 1, mounts: [{ path: "/data", name: "data" }] } } }),
      task({ itemRef: "app:s:ex", kind: "app", resourceType: "application", resourceId: "app2", result: { volumes: { declared: 1, mounts: [{ path: "/cache", name: "cache" }] } } }),
      task({ itemRef: "service:s:svc1", kind: "service", resourceType: "application", resourceId: "app3" }),
      task({ itemRef: "database:s:pg", kind: "database", resourceType: "database", resourceId: "db1" }),
      task({ itemRef: "database:s:pgvol", kind: "database", resourceType: "database", resourceId: "db2", result: { credentialsCarried: true } }),
      task({ itemRef: "database:s:mongo", kind: "database", resourceType: "database", resourceId: "db3" }),
      task({ itemRef: "data:database:s:pg", kind: "data", status: "FAILED", output: "the staged artifact differs from the restored one" }),
      task({ itemRef: "app:s:failed", kind: "app", status: "FAILED" }),
    ],
    ...over,
  });
  const prisma = (o = op()) =>
    readOnly({
      bulkOperation: { findUnique: async () => o },
      database: {
        findMany: async () => [
          { id: "db1", name: "pg", engine: "POSTGRES", version: "16", image: "postgres:16" },
          { id: "db2", name: "pgvol", engine: "POSTGRES", version: "16", image: "postgres:16" },
          { id: "db3", name: "mongo", engine: "MONGO", version: "7", image: "mongo:7" },
        ],
        findUnique: async () => ({ version: "16", image: "postgres:16", status: "NEW" }),
      },
      application: { findMany: async () => [{ id: "app1", name: "web" }, { id: "app2", name: "cache-app" }, { id: "app3", name: "svc" }] },
      restore: { count: async () => 0 },
      backup: { count: async () => 0 },
      migrationVolumeTransfer: {
        findMany: async () => [{ itemRef: "volume:s:abc:data", state: "DONE", rawBytesDone: 100n, bytesDone: 40n, rawBytesTotal: 100n, bps: 10n, entries: 7, error: null }],
      },
    });
  const port = (p = prisma()) => new PrismaDataPort(p, { log: async () => undefined } as never, {} as never, {} as never);

  it("reads the data plane of the op: volumes, databases (plane + data task), apps, services and the token state, without writing anything", async () => {
    const s = await port().snapshot(makeRun());
    expect(s).toMatchObject({ opId: "op1", targetServerId: "srv-target", hubBase: "https://hub.example.com", tokenActive: true, vxEnabled: true });
    expect(s.apps).toEqual([{ itemRef: "app:s:abc", name: "web" }, { itemRef: "app:s:ex", name: "cache-app" }]);
    expect(s.services).toEqual([{ itemRef: "service:s:svc1", name: "svc" }]);

    const byRef = Object.fromEntries(s.databases.map((d) => [d.itemRef, d]));
    expect(byRef["database:s:pg"]).toMatchObject({ plane: "logical", task: "failed", taskFailure: "restored-differs", engine: "POSTGRES", dbId: "db1" });
    expect(byRef["database:s:pgvol"]).toMatchObject({ plane: "volume", task: "none" });
    expect(byRef["database:s:mongo"]).toMatchObject({ plane: "unsupported", unsupportedReason: expect.any(String) });

    const vols = Object.fromEntries(s.volumes.map((v) => [v.itemRef, v]));
    expect(vols["volume:s:abc:data"]).toMatchObject({ state: "DONE", rawBytesDone: 100, bytesDone: 40, bps: 10, entries: 7, inventory: { found: true, rawBytes: 100, entries: 7 }, disk: { ok: true, unknown: false }, destType: "app-volume", ownerName: "web", excluded: false });
    expect(vols["volume:s:ex:cache"]).toMatchObject({ state: "EXCLUDED", excluded: true });
    expect(vols["volume:srv:pgvol:data"] ?? vols["volume:s:pgvol:data"]).toMatchObject({ destType: "db-data", gates: expect.any(Array) });
  });

  it("carries when a database's data task finished, so a restore from before the freeze can be told from the final one", async () => {
    const at = new Date("2026-11-20T09:45:00.000Z");
    const tasks = op().tasks.map((t) => (t.itemRef === "data:database:s:pg" ? { ...t, status: "DONE", output: null, finishedAt: at } : t));
    const done = (await port(prisma(op({ tasks }))).snapshot(makeRun())).databases.find((d) => d.itemRef === "database:s:pg")!;
    expect(done).toMatchObject({ task: "done", finishedAt: at.toISOString() });
    // a task that has not finished (failed / running / never started) has no finish time to trust
    const failed = (await port().snapshot(makeRun())).databases.find((d) => d.itemRef === "database:s:pg")!;
    expect(failed.finishedAt).toBeNull();
  });

  it("a revoked / expired / cancelled token reads as inactive", async () => {
    for (const over of [{ migrationTokenHash: null }, { migrationTokenExpiresAt: new Date(NOW - 1000) }, { cancelRequestedAt: new Date() }]) {
      expect((await port(prisma(op(over))).snapshot(makeRun())).tokenActive).toBe(false);
    }
  });

  it("refuses an op that is gone, is not an import, or belongs to another user", async () => {
    for (const bad of [null, op({ kind: "bulk" }), op({ actorId: "someone-else" })]) {
      await expect(port(readOnly({ bulkOperation: { findUnique: async () => bad } })).snapshot(makeRun())).rejects.toEqual(new DataPortError("op-missing"));
    }
    await expect(port().snapshot(makeRun({ opId: null }))).rejects.toBeInstanceOf(DataPortError);
  });

  it("revokeToken is the same updateMany as the token service and audits only when it took effect", async () => {
    const audit = { log: jest.fn(async () => undefined) };
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const p = new PrismaDataPort(readOnly({ bulkOperation: { updateMany } }), audit as never, {} as never, {} as never);
    await p.revokeToken(makeRun());
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "op1", migrationTokenHash: { not: null } }, data: { migrationTokenHash: null, migrationTokenExpiresAt: null } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.migration_token.revoke", target: "op1" }));
    updateMany.mockResolvedValueOnce({ count: 0 });
    audit.log.mockClear();
    await p.revokeToken(makeRun());
    expect(audit.log).not.toHaveBeenCalled();
    await p.revokeToken(makeRun({ opId: null })); // no op: nothing
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("issueToken goes through the executor's own reissue (authorization, audit); a refusal is a fixed error with no message", async () => {
    const executor = { reissueMigrationToken: jest.fn(async () => ({ token: `tugra_mig_${"C".repeat(43)}`, expiresAt: new Date(NOW + 1000), command: "x" })) };
    const p = new PrismaDataPort(prisma(), { log: async () => undefined } as never, executor as never, {} as never);
    const r = await p.issueToken(makeRun(), "https://hub.example.com");
    expect(executor.reissueMigrationToken).toHaveBeenCalledWith("user1", "op1", "https://hub.example.com");
    expect(r.token).toMatch(/^tugra_mig_/);
    executor.reissueMigrationToken.mockRejectedValueOnce(new Error("secret internal detail"));
    await expect(p.issueToken(makeRun(), "https://hub.example.com")).rejects.toEqual(new DataPortError("token-rejected"));
  });

  it("abortTransfers aborts through the importer's own rules and tolerates an apply that cannot be aborted", async () => {
    const userAbort = jest.fn(async (_u: string, _o: string, ref: string) => {
      if (ref === "volume:s:b:data") throw new Error("an apply is running");
    });
    const moduleRef = { get: jest.fn(() => ({ userAbort })) };
    const p = new PrismaDataPort(prisma(), {} as never, {} as never, moduleRef as never);
    expect(await p.abortTransfers(makeRun(), ["volume:s:a:data", "volume:s:b:data"])).toEqual(["volume:s:a:data"]);
    expect(userAbort).toHaveBeenCalledWith("user1", "op1", "volume:s:a:data");
    expect(await p.abortTransfers(makeRun(), [])).toEqual([]);
  });
});

describe("ServerCapabilityPort", () => {
  const build = (caps: string[] | null, setCapabilities = jest.fn(async () => undefined)) => {
    const prisma = readOnly({ server: { findUnique: async () => (caps === null ? null : { capabilities: caps }) } });
    return { port: new ServerCapabilityPort(prisma, { setCapabilities } as never), setCapabilities };
  };
  it("adds the capability through the servers service and says it was added", async () => {
    const { port, setCapabilities } = build(["deploy", "logs"]);
    expect(await port.ensureMigrate("user1", "srv")).toEqual({ ok: true, added: true });
    expect(setCapabilities).toHaveBeenCalledWith("user1", "srv", ["deploy", "logs", "migrate"]);
  });
  it("a capability the owner already granted is not touched and is never reported as added", async () => {
    const { port, setCapabilities } = build(["deploy", "migrate"]);
    expect(await port.ensureMigrate("user1", "srv")).toEqual({ ok: true, added: false });
    expect(setCapabilities).not.toHaveBeenCalled();
  });
  it("reports a missing server and a missing permission as fixed reasons", async () => {
    expect(await build(null).port.ensureMigrate("u", "s")).toEqual({ ok: false, reason: "not-found" });
    const denied = build(["deploy"], jest.fn(async () => Promise.reject(new ForbiddenException("no"))));
    expect(await denied.port.ensureMigrate("u", "s")).toEqual({ ok: false, reason: "forbidden" });
    const boom = build(["deploy"], jest.fn(async () => Promise.reject(new Error("db"))));
    await expect(boom.port.ensureMigrate("u", "s")).rejects.toThrow("db");
  });
  it("release removes only `migrate` and is a no-op when it is absent", async () => {
    const a = build(["deploy", "migrate", "logs"]);
    await a.port.releaseMigrate("user1", "srv");
    expect(a.setCapabilities).toHaveBeenCalledWith("user1", "srv", ["deploy", "logs"]);
    const b = build(["deploy"]);
    await b.port.releaseMigrate("user1", "srv");
    expect(b.setCapabilities).not.toHaveBeenCalled();
    await build(null).port.releaseMigrate("u", "s");
  });
});

describe("CoolifySourceApi", () => {
  const session = (over: Record<string, unknown> = {}) => ({ id: "sess1", actorId: "user1", sourceKind: "coolify", status: "active", expiresAt: new Date(NOW + 3600_000), baseUrl: "https://coolify.example.com", tokenEnc: "enc", ...over });
  const build = (s: Record<string, unknown> | null = session(), transport?: CoolifyControlTransport) => {
    const decrypt = jest.fn(() => "SECRET-TOKEN");
    const factory = jest.fn((_b: string, _t: string) => new CoolifyControl(transport ?? { request: async () => ({ status: 200, body: { status: "running:healthy" } }) }));
    const api = new CoolifySourceApi(readOnly({ importSession: { findUnique: async () => s } }), { decrypt } as never, factory);
    return { api, decrypt, factory };
  };

  it("builds the control client from the session (token decrypted in memory, handed only to the factory)", async () => {
    const { api, decrypt, factory } = build();
    expect(await api.available(makeRun())).toEqual({ ok: true });
    expect(await api.state(makeRun(), "application", "abc")).toEqual({ ok: true, state: "running" });
    expect(decrypt).toHaveBeenCalledWith("enc");
    expect(factory).toHaveBeenCalledWith("https://coolify.example.com", "SECRET-TOKEN");
  });
  it("only Coolify has a control client; an unusable session is `session-expired`", async () => {
    expect(await build().api.available(makeRun({ sourceKind: "dokploy" }))).toEqual({ ok: false, reason: "unsupported" });
    expect(await build().api.available(makeRun({ sessionId: null }))).toEqual({ ok: false, reason: "session-expired" });
    for (const s of [null, session({ actorId: "other" }), session({ status: "revoked" }), session({ expiresAt: new Date(NOW - 1) }), session({ sourceKind: "dokploy" })]) {
      expect(await build(s).api.available(makeRun())).toEqual({ ok: false, reason: "session-expired" });
    }
  });
  it("maps control errors to fixed reasons and never leaks the token", async () => {
    const t: CoolifyControlTransport = { request: async () => ({ status: 403, body: { message: "token SECRET-TOKEN cannot write" } }) };
    const { api } = build(session(), t);
    const r = await api.stop(makeRun(), "application", "abc");
    expect(r).toEqual({ ok: false, reason: "forbidden" });
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
    const boom: CoolifyControlTransport = { request: async () => Promise.reject(new Error("socket")) };
    expect(await build(session(), boom).api.start(makeRun(), "service", "s1")).toEqual({ ok: false, reason: "unreachable" });
    const notFound: CoolifyControlTransport = { request: async () => Promise.reject(new ControlError("not-found")) };
    expect(await build(session(), notFound).api.state(makeRun(), "database", "d1")).toEqual({ ok: false, reason: "not-found" });
  });
  it("an SSRF-refused base URL is a fixed `unreachable`", async () => {
    const api = new CoolifySourceApi(readOnly({ importSession: { findUnique: async () => session({ baseUrl: "http://169.254.169.254" }) } }), { decrypt: () => "t" } as never);
    expect(await api.available(makeRun())).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("ObjectMigrationPort", () => {
  const view = { id: "om1", status: "SEEDED", phase: null, cancelRequested: false, warnings: [{ code: "x", level: "blocker" }, { code: "y", level: "warn" }], buckets: [{ idx: 0, srcBucket: "media", dstBucket: "media", selected: true, status: "SEEDED", diffMissing: 1, diffDiffer: 2, diffExtra: 3, lastError: "x", srcObjects: 10 }], srcEndpoint: "https://s3.example.com" };
  it("reduces a view to status and counters (no endpoints, no credentials) and swallows an unreadable one as null", async () => {
    const svc = { get: jest.fn(async () => view) };
    const p = new ObjectMigrationPort(svc as never);
    const v = (await p.get("user1", "om1"))!;
    expect(v).toEqual({ id: "om1", status: "SEEDED", phase: null, cancelRequested: false, blockers: 1, buckets: [{ srcBucket: "media", selected: true, status: "SEEDED", diffMissing: 1, diffDiffer: 2, diffExtra: 3 }] });
    expect(JSON.stringify(v)).not.toContain("s3.example.com");
    svc.get.mockRejectedValueOnce(new ForbiddenException());
    expect(await p.get("user1", "om1")).toBeNull();
  });
  it("starts the passes with the right arguments: the final pass acknowledges frozen writes and never removes anything", async () => {
    const svc = { start: jest.fn(async () => undefined), verify: jest.fn(async () => undefined), cancel: jest.fn(async () => undefined) };
    const p = new ObjectMigrationPort(svc as never);
    await p.startSeed("u", "om1");
    await p.startFinal("u", "om1");
    await p.verify("u", "om1");
    await p.cancel("u", "om1");
    expect(svc.start.mock.calls).toEqual([["u", "om1", { phase: "seed" }], ["u", "om1", { phase: "final", acknowledgeWritesFrozen: true, removeExtraneous: false }]]);
    expect(svc.verify).toHaveBeenCalledWith("u", "om1");
    expect(svc.cancel).toHaveBeenCalledWith("u", "om1");
  });
});

describe("AgentSourceHost / TargetDbStats", () => {
  it("dispatches a script through the agent with the requested capability", async () => {
    const sendCommand = jest.fn(async () => ({ exitCode: 0, output: "ok" }));
    expect(await new AgentSourceHost({ sendCommand } as never).run("srv", "echo 1", "migrate", 1234)).toEqual({ exitCode: 0, output: "ok" });
    expect(sendCommand).toHaveBeenCalledWith("srv", "echo 1", "migrate", 1234);
  });

  const db = { itemRef: "database:s:pg", dbId: "db1", name: "pg", engine: "POSTGRES", plane: "logical" as const, unsupportedReason: null, task: "done" as const, taskFailure: null, finishedAt: null };
  const build = (row: unknown, run = jest.fn(async () => ({ exitCode: 0, output: "public.t\t5\t0\n" }))) => ({
    run,
    stats: new TargetDbStats(
      readOnly({ database: { findUnique: async () => row } }),
      { decrypt: () => JSON.stringify({ username: "app", password: "pw'x", database: "appdb" }) } as never,
      { run } as never,
    ),
  });

  it("runs the statement on the database's own server under the `database` capability and parses the answer", async () => {
    const { stats, run } = build({ id: "db1", serverId: "srv-db", engine: "POSTGRES", credentials: "enc" });
    const s = await stats.measureTarget(makeRun(), db, "exact");
    expect(s).toMatchObject({ state: "measured", kind: "tables", mode: "exact", tables: [{ name: "public.t", rows: 5, estimated: false, expires: 0 }] });
    const [server, script, cap] = run.mock.calls[0] as unknown as [string, string, string];
    expect(server).toBe("srv-db");
    expect(cap).toBe("database");
    expect(script).toContain("docker exec -e PGPASSWORD='pw'\\''x' tugra_db_db1 psql");
  });
  it("failures are fixed reasons, never an empty (passing) measurement", async () => {
    expect(await build(null).stats.measureTarget(makeRun(), db, "exact")).toMatchObject({ state: "failed", reason: "db-missing", tables: [] });
    expect(await build({ id: "db1", serverId: "s", engine: "POSTGRES", credentials: "enc" }, jest.fn(async () => Promise.reject(new Error("offline")))).stats.measureTarget(makeRun(), db, "exact")).toMatchObject({ state: "failed", reason: "verify-exec" });
    expect(await build({ id: "db1", serverId: "s", engine: "POSTGRES", credentials: "enc" }, jest.fn(async () => ({ exitCode: 1, output: "" }))).stats.measureTarget(makeRun(), db, "exact")).toMatchObject({ state: "failed", reason: "verify-exec" });
    expect(await build({ id: "db1", serverId: "s", engine: "POSTGRES", credentials: "enc" }, jest.fn(async () => ({ exitCode: 0, output: "garbage" }))).stats.measureTarget(makeRun(), db, "exact")).toMatchObject({ state: "failed", reason: "verify-parse" });
    expect(await build({ id: "db1", serverId: "s", engine: "MONGO", credentials: "enc" }).stats.measureTarget(makeRun(), { ...db, engine: "MONGO" }, "exact")).toMatchObject({ state: "skipped", reason: "no-verify" });
    expect(await build(null).stats.measureTarget(makeRun(), { ...db, dbId: null }, "exact")).toMatchObject({ state: "failed", reason: "db-missing" });
    const badName = new TargetDbStats(readOnly({ database: { findUnique: async () => ({ id: "db1", serverId: "s", engine: "POSTGRES", credentials: "enc" }) } }), { decrypt: () => JSON.stringify({ username: "a;b", password: "p", database: "d" }) } as never, { run: jest.fn() } as never);
    expect(await badName.measureTarget(makeRun(), db, "exact")).toMatchObject({ state: "failed", reason: "invalid-name" });
  });
});

describe("PrismaRuntime", () => {
  it("reports app/database status, host rows and every task that did not end DONE (skipped ones excluded)", async () => {
    const prisma = readOnly({
      bulkTask: {
        findMany: async () => [
          { itemRef: "app:s:a", kind: "app", status: "DONE", resourceType: "application", resourceId: "a1", result: { unresolvedEnv: 2, droppedInvalidKeys: ["X"] } },
          { itemRef: "app:s:gone", kind: "app", status: "DONE", resourceType: "application", resourceId: "a2", result: null },
          { itemRef: "database:s:d", kind: "database", status: "DONE", resourceType: "database", resourceId: "d1", result: null },
          { itemRef: "app:s:f", kind: "app", status: "FAILED", resourceType: null, resourceId: null, result: null },
          { itemRef: "service:s:k", kind: "service", status: "SKIPPED", resourceType: null, resourceId: null, result: null },
          { itemRef: null, kind: "app", status: "FAILED", resourceType: null, resourceId: null, result: null },
        ],
      },
      application: { findMany: async () => [{ id: "a1", name: "web", status: "RUNNING" }] },
      database: { findMany: async () => [{ id: "d1", name: "pg", status: "STOPPED" }] },
      cutoverDomain: { findMany: async () => [{ hostname: "a.example.com", state: "READY", stateful: true, blockReason: null }] },
    });
    const rt = await new PrismaRuntime(prisma).snapshot(makeRun());
    expect(rt.apps).toEqual([
      { itemRef: "app:s:a", name: "web", status: "RUNNING", envUnresolved: 2, envDropped: 1 },
      { itemRef: "app:s:gone", name: null, status: "MISSING", envUnresolved: 0, envDropped: 0 },
    ]);
    expect(rt.databases).toEqual([{ itemRef: "database:s:d", name: "pg", status: "STOPPED" }]);
    expect(rt.hosts).toEqual([{ hostname: "a.example.com", state: "READY", stateful: true, blockReason: null }]);
    expect(rt.incomplete).toEqual([{ itemRef: "app:s:f", kind: "app", status: "FAILED" }]);
    expect(await new PrismaRuntime(prisma).snapshot(makeRun({ opId: null }))).toEqual({ apps: [], databases: [], hosts: [], incomplete: [] });
  });
});

describe("CutoverFlipPlans", () => {
  const rows = [{ hostname: "b.example.com", state: "READY", stateful: false }, { hostname: "a.example.com", state: "READY", stateful: true }];
  const prisma = readOnly({ cutoverDomain: { findMany: async () => rows } });
  it("two-box: the flip plan's own hash (the confirm token) and the stateful subset of its hosts", async () => {
    const cutover = { flipPlan: jest.fn(async () => ({ planHash: "f".repeat(32), entries: [{ hostname: "a.example.com" }, { hostname: "b.example.com" }] })) };
    const r = await new CutoverFlipPlans(prisma, cutover as never).plan(makeRun());
    expect(r).toEqual({ planHash: "f".repeat(32), hosts: ["a.example.com", "b.example.com"], statefulHosts: ["a.example.com"], unavailable: null });
    expect(cutover.flipPlan).toHaveBeenCalledWith("user1", "op1", {});
  });
  it("a plan that cannot be computed is a fixed code, not the service's message", async () => {
    const cutover = { flipPlan: jest.fn(async () => Promise.reject(new Error("a Cloudflare token detail"))) };
    expect(await new CutoverFlipPlans(prisma, cutover as never).plan(makeRun())).toEqual({ planHash: null, hosts: [], statefulHosts: [], unavailable: "flip-plan-error" });
    expect((await new CutoverFlipPlans(prisma, cutover as never).plan(makeRun({ opId: null }))).unavailable).toBe("no-op");
  });
  it("swap-proxy: a deterministic digest of the hosts and their state, no DNS involved", async () => {
    const cutover = { flipPlan: jest.fn() };
    const run = makeRun({ topology: "swap-proxy" });
    const a = await new CutoverFlipPlans(prisma, cutover as never).plan(run);
    const b = await new CutoverFlipPlans(prisma, cutover as never).plan(run);
    expect(a.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toEqual(b);
    expect(a.statefulHosts).toEqual(["a.example.com"]);
    expect(cutover.flipPlan).not.toHaveBeenCalled();
    const moved = await new CutoverFlipPlans(readOnly({ cutoverDomain: { findMany: async () => [{ ...rows[0], state: "BLOCKED" }, rows[1]] } }), cutover as never).plan(run);
    expect(moved.planHash).not.toBe(a.planHash);
  });
});

describe("ImporterDrift", () => {
  const plan = (planHash: string) => jest.fn(async () => ({ planHash }));
  it("same / changed from the plan hash, and unknown for anything it could not read", async () => {
    const run = makeRun();
    expect(await new ImporterDrift({ plan: plan(run.planHash) } as never).check(run)).toEqual({ result: "same" });
    expect(await new ImporterDrift({ plan: plan("0".repeat(32)) } as never).check(run)).toEqual({ result: "changed" });
    expect(await new ImporterDrift({ plan: jest.fn(async () => Promise.reject(new Error("session expired"))) } as never).check(run)).toEqual({ result: "unknown" });
    expect(await new ImporterDrift({ plan: plan(run.planHash) } as never).check(makeRun({ sessionId: null }))).toEqual({ result: "unknown" });
  });
  it("re-plans with the same data modes and session the run was created with", async () => {
    const p = plan(makeRun().planHash);
    const run = { ...makeRun(), applyInput: { sourceKind: "coolify" as const, targetServerId: "t", planHash: makeRun().planHash, dbDataModes: { "database:s:a": "volume" as const } } };
    await new ImporterDrift({ plan: p } as never).check(run);
    expect(p).toHaveBeenCalledWith("user1", { sourceKind: "coolify", sessionId: "sess1", dbDataModes: { "database:s:a": "volume" } });
  });
});
