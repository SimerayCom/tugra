import { ContainerHealthRunnerService } from "./container-health.runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

const SERVER = { id: "s1", name: "box", teamId: "t1", hostname: "box.local" };

// inspect output: one app container; `restartCount` + extra event lines overridable
function inspectOut(restartCount: number, extra = "") {
  return ["##INSPECT", `/tugra_app1\tc1\trunning\t0\tfalse\t${restartCount}\t2026-10-30T00:00:00Z\t0001-01-01T00:00:00Z\t`, "##EVENTS", extra].join("\n");
}

function make(opts: { rows?: unknown[]; online?: boolean; output?: string; exitCode?: number; apps?: unknown[]; metrics?: unknown[]; servers?: unknown[]; delayMs?: number } = {}) {
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const upsert = jest.fn().mockResolvedValue({});
  const update = jest.fn().mockResolvedValue({});
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const create = jest.fn().mockResolvedValue({});
  const prisma = {
    server: { findMany: jest.fn().mockResolvedValue(opts.servers ?? [SERVER]) },
    containerState: { findMany: jest.fn().mockResolvedValue(opts.rows ?? []), upsert, update, updateMany, deleteMany },
    containerEvent: { create },
    containerMetric: { findMany: jest.fn().mockResolvedValue(opts.metrics ?? []) },
    application: { findMany: jest.fn().mockResolvedValue((opts.apps ?? [{ id: "app1", name: "Shop", status: "RUNNING" }]).map((a) => ({ serverId: "s1", ...(a as object) }))) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  // The poll command returns the inspect/events output; a later `docker logs` fetch returns a canned tail.
  const sendCommand = jest.fn().mockImplementation(async (_id: string, cmd: string) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return Promise.resolve(
      cmd.includes("docker logs")
        ? { exitCode: 0, output: "2026-10-30T00:00:01Z panic: boom\n" }
        : { exitCode: opts.exitCode ?? 0, output: opts.output ?? inspectOut(0) },
    );
  });
  const agentWs = { isOnline: jest.fn().mockReturnValue(opts.online ?? true), sendCommand } as unknown as AgentWsServer;
  const notifications = { fireForEvent } as unknown as NotificationsService;
  return { svc: new ContainerHealthRunnerService(prisma, agentWs, notifications), prisma, fireForEvent, upsert, update, updateMany, deleteMany, create, sendCommand };
}

const prevRow = (over: Record<string, unknown> = {}) => ({
  serverId: "s1", containerName: "tugra_app1", containerId: "c1", status: "running", exitCode: 0, oomKilled: false,
  restartCount: 0, startedAt: null, finishedAt: null, health: null, lastEventTs: 0n, updatedAt: new Date(),
  lastNotifiedKey: null, lastNotifiedAt: null, restartCountAtNotify: 0, unhealthySince: null, healthNotifiedAt: null, ...over,
});

// An inspect row with an explicit HEALTHCHECK status (parts[8]); status/restartCount overridable.
function inspectHealth(health: string, over: { status?: string; restartCount?: number } = {}) {
  const status = over.status ?? "running";
  const restartCount = over.restartCount ?? 0;
  return ["##INSPECT", `/tugra_app1\tc1\t${status}\t0\tfalse\t${restartCount}\t2026-10-30T00:00:00Z\t0001-01-01T00:00:00Z\t${health}`, "##EVENTS", ""].join("\n");
}

describe("ContainerHealthRunnerService.runTick", () => {
  it("skips a server whose agent is offline (no command sent)", async () => {
    const { svc, sendCommand } = make({ online: false });
    await svc.runTick();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("swallows a non-zero exit (state untouched, no fire)", async () => {
    const { svc, fireForEvent, upsert } = make({ rows: [prevRow()], exitCode: 1 });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("swallows a thrown sendCommand (bulk revoked / timeout) and does not crash", async () => {
    const { svc, fireForEvent } = make({ rows: [prevRow()] });
    (svc as unknown as { agentWs: AgentWsServer }).agentWs.sendCommand = jest.fn().mockRejectedValue(new Error("not granted")) as never;
    await expect(svc.runTick()).resolves.toEqual({ settling: false, settlingKeys: [] });
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("seeds silently on the first tick (no prior rows → upsert, never fire)", async () => {
    const { svc, fireForEvent, upsert } = make({ rows: [], output: inspectOut(5) });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("fires container_crashed once on a restartCount increase, with resolved label/kind + reason + frozen logs", async () => {
    const { svc, fireForEvent, create, sendCommand } = make({ rows: [prevRow({ restartCount: 2, restartCountAtNotify: 2 })], output: inspectOut(3) });
    await svc.runTick();
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "container_crashed",
      expect.objectContaining({ containerName: "tugra_app1", label: "Shop", kind: "app", resourceId: "app1", reason: expect.any(String) }),
    );
    // The raw log tail is NOT sent to external channels (secret-leak risk) — only `reason` is.
    expect(fireForEvent.mock.calls[0][2]).not.toHaveProperty("logTail");
    // The log tail is fetched over the "logs" capability (same gate as the interactive reader), not "bulk".
    const logCall = sendCommand.mock.calls.find((c: unknown[]) => String(c[1]).includes("docker logs"));
    expect(logCall?.[2]).toBe("logs");
    // A ContainerEvent row is appended with the frozen pre-crash log tail (in-app only).
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ containerName: "tugra_app1", kind: "crash", logTail: expect.stringContaining("panic: boom") }) }));
  });

  it("records a ContainerEvent even when the alert is suppressed (stopped app)", async () => {
    const { svc, fireForEvent, create } = make({ rows: [prevRow({ restartCount: 2, restartCountAtNotify: 2 })], output: inspectOut(3), apps: [{ id: "app1", name: "Shop", status: "STOPPED" }] });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "crash" }) }));
  });

  it("swallows a ContainerEvent write failure without aborting the tick (per-container isolation)", async () => {
    const { svc, create, upsert } = make({ rows: [prevRow({ restartCount: 2, restartCountAtNotify: 2 }), prevRow({ containerName: "tugra_gone" })], output: inspectOut(3) });
    create.mockRejectedValueOnce(new Error("23502 bad byte"));
    await expect(svc.runTick()).resolves.toEqual({ settling: false, settlingKeys: [] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1); // state was persisted before the failed timeline row
  });

  it("a server with no containers clears its rows without a NUL placeholder (PostgreSQL rejects 0x00 in a query)", async () => {
    const { svc, deleteMany } = make({ rows: [prevRow({ restartCount: 0 })], output: "" });
    await svc.runTick();
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deleteMany.mock.calls[0][0])).not.toContain("\\u0000");
    expect(deleteMany.mock.calls[0][0].where).not.toHaveProperty("containerName");
  });

  it("strips NUL bytes from the captured log tail (Postgres TEXT rejects 0x00)", async () => {
    const { svc, create } = make({ rows: [prevRow({ restartCount: 2, restartCountAtNotify: 2 })], output: inspectOut(3) });
    (svc as unknown as { agentWs: AgentWsServer }).agentWs.sendCommand = jest
      .fn()
      .mockImplementation((_id: string, cmd: string) =>
        Promise.resolve(cmd.includes("docker logs") ? { exitCode: 0, output: "a\u0000b\u0000c" } : { exitCode: 0, output: inspectOut(3) }),
      ) as never;
    await svc.runTick();
    expect(create.mock.calls[0][0].data.logTail).toBe("abc");
  });

  it("suppresses the alert for an app the operator STOPPED (still persists state)", async () => {
    const { svc, fireForEvent, upsert } = make({ rows: [prevRow({ restartCount: 2, restartCountAtNotify: 2 })], output: inspectOut(3), apps: [{ id: "app1", name: "Shop", status: "STOPPED" }] });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
  });

  it("deletes state rows for containers no longer present", async () => {
    const { svc, deleteMany } = make({ rows: [prevRow(), prevRow({ containerName: "tugra_gone" })], output: inspectOut(0) });
    await svc.runTick();
    expect(deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ serverId: "s1", containerName: { notIn: ["tugra_app1"] } }) }));
  });

  it("fires container_unhealthy on the transition into unhealthy and persists unhealthySince", async () => {
    const { svc, fireForEvent, upsert } = make({ rows: [prevRow({ health: "healthy" })], output: inspectHealth("unhealthy") });
    await svc.runTick();
    expect(fireForEvent).toHaveBeenCalledTimes(1);
    const [teamId, type, ctx] = fireForEvent.mock.calls[0];
    expect(teamId).toBe("t1");
    expect(type).toBe("container_unhealthy");
    expect(ctx).toMatchObject({ containerName: "tugra_app1", health: "unhealthy" });
    expect(ctx.unhealthySince).toBeTruthy(); // ISO string, not empty
    expect((upsert.mock.calls[0][0].update as { unhealthySince: Date | null }).unhealthySince).toBeInstanceOf(Date);
  });

  it("does NOT re-fire on a steady unhealthy container already alerted this episode", async () => {
    const since = new Date(Date.now() - 60_000);
    const { svc, fireForEvent } = make({ rows: [prevRow({ health: "unhealthy", unhealthySince: since, healthNotifiedAt: since })], output: inspectHealth("unhealthy") });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("seeds an already-unhealthy container silently (records unhealthySince + healthNotifiedAt, never fires)", async () => {
    const { svc, fireForEvent, upsert } = make({ rows: [], output: inspectHealth("unhealthy") });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
    const data = upsert.mock.calls[0][0].create as { unhealthySince: Date | null; healthNotifiedAt: Date | null };
    expect(data.unhealthySince).toBeInstanceOf(Date);
    expect(data.healthNotifiedAt).toBeInstanceOf(Date); // seed-ack ⇒ the diff treats this episode as already alerted
  });

  const LIMIT_512 = 512 * 1024 * 1024; // docker stats' memTotal for `--memory 512m`
  const memSample = (over: Record<string, unknown> = {}) => ({ containerName: "tugra_app1", containerId: "c1", memPct: 95, memTotal: BigInt(LIMIT_512), ts: new Date(), ...over });
  const MEM_HIGH = [memSample({ memPct: 95 }), memSample({ memPct: 93 }), memSample({ memPct: 96 })];
  const APP_512 = [{ id: "app1", name: "Shop", status: "RUNNING", memoryMb: 512 }];

  it("fires container_mem_pressure for a LIMITED, running app under sustained pressure and records the cooldown", async () => {
    const { svc, fireForEvent, update } = make({ rows: [prevRow()], output: inspectOut(0), metrics: MEM_HIGH, apps: APP_512 });
    await svc.runTick();
    expect(fireForEvent).toHaveBeenCalledTimes(1);
    const [teamId, type, ctx] = fireForEvent.mock.calls[0];
    expect(teamId).toBe("t1");
    expect(type).toBe("container_mem_pressure");
    expect(ctx).toMatchObject({ containerName: "tugra_app1", limitMb: 512, memPct: 96 });
    expect((update.mock.calls[0][0].data as { memNotifiedAt: Date }).memNotifiedAt).toBeInstanceOf(Date);
  });

  it("does NOT fire for an app with NO memory limit (memPct would be share-of-host)", async () => {
    const { svc, fireForEvent } = make({ rows: [prevRow()], output: inspectOut(0), metrics: MEM_HIGH, apps: [{ id: "app1", name: "Shop", status: "RUNNING", memoryMb: null }] });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire when the sample's memTotal does not match the declared limit (COMPOSE/stale limit not actually applied)", async () => {
    // memoryMb=512 but the running container is unlimited → memTotal is host RAM (8 GB), not 512 MB.
    const hostRam = 8 * 1024 * 1024 * 1024;
    const { svc, fireForEvent } = make({
      rows: [prevRow()], output: inspectOut(0), apps: APP_512,
      metrics: [memSample({ memTotal: BigInt(hostRam) }), memSample({ memTotal: BigInt(hostRam) }), memSample({ memTotal: BigInt(hostRam) })],
    });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire on stale samples (newest sample older than the freshness window → dead container / stopped agent)", async () => {
    const old = new Date(Date.now() - 120_000);
    const { svc, fireForEvent } = make({
      rows: [prevRow()], output: inspectOut(0), apps: APP_512,
      metrics: [memSample({ ts: old }), memSample({ ts: old }), memSample({ ts: old })],
    });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("ignores samples from a previous incarnation (different containerId)", async () => {
    const { svc, fireForEvent } = make({
      rows: [prevRow()], output: inspectOut(0), apps: APP_512,
      metrics: [memSample({ containerId: "old" }), memSample({ containerId: "old" }), memSample({ containerId: "old" })],
    });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("suppresses mem pressure within its own cooldown", async () => {
    const { svc, fireForEvent } = make({ rows: [prevRow({ memNotifiedAt: new Date() })], output: inspectOut(0), metrics: MEM_HIGH, apps: APP_512 });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire when usage is below the threshold", async () => {
    const { svc, fireForEvent } = make({
      rows: [prevRow()], output: inspectOut(0), apps: APP_512,
      metrics: [memSample({ memPct: 40 }), memSample({ memPct: 42 }), memSample({ memPct: 39 })],
    });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("suppresses the unhealthy alert for a STOPPED app (still persists state)", async () => {
    const { svc, fireForEvent, upsert } = make({ rows: [prevRow({ health: "healthy" })], output: inspectHealth("unhealthy"), apps: [{ id: "app1", name: "Shop", status: "STOPPED" }] });
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
  });
});

describe("ContainerHealthRunnerService settling + overlap", () => {
  const recent = new Date(Date.now() - 20_000).toISOString();
  const exitedOut = (finished: string) => ["##INSPECT", `/tugra_app1\tc1\texited\t143\tfalse\t0\t2026-10-30T00:00:00Z\t${finished}\t`, "##EVENTS", ""].join("\n");

  it("reports settling while a container's HEALTHCHECK is still starting", async () => {
    const { svc } = make({ rows: [prevRow()], output: inspectHealth("starting") });
    expect(await svc.runTick()).toEqual({ settling: true, settlingKeys: ["s1/tugra_app1"] });
  });

  it("reports settling for a container that died moments ago (a restart in flight)", async () => {
    const { svc } = make({ rows: [prevRow()], output: exitedOut(recent) });
    expect(await svc.runTick()).toEqual({ settling: true, settlingKeys: ["s1/tugra_app1"] });
  });

  it("is not settling once the container is healthy, nor for one that has been down a long while", async () => {
    expect(await make({ rows: [prevRow()], output: inspectHealth("healthy") }).svc.runTick()).toEqual({ settling: false, settlingKeys: [] });
    const old = new Date(Date.now() - 3_600_000).toISOString();
    expect(await make({ rows: [prevRow()], output: exitedOut(old) }).svc.runTick()).toEqual({ settling: false, settlingKeys: [] });
  });

  it("does not report settling for an app the operator stopped", async () => {
    const { svc } = make({ rows: [prevRow()], output: exitedOut(recent), apps: [{ id: "app1", name: "Shop", status: "STOPPED" }] });
    expect(await svc.runTick()).toEqual({ settling: false, settlingKeys: [] });
  });

  it("overlapping runTick calls share one poll (no race on the same state rows)", async () => {
    const { svc, sendCommand } = make({ rows: [prevRow()], output: inspectHealth("healthy") });
    const [a, b] = await Promise.all([svc.runTick(), svc.runTick()]);
    expect(a).toEqual(b);
    expect(sendCommand.mock.calls.filter((c) => !String(c[1]).includes("docker logs"))).toHaveLength(1);
    await svc.runTick(); // and a later call polls again
    expect(sendCommand.mock.calls.filter((c) => !String(c[1]).includes("docker logs"))).toHaveLength(2);
  });
});

describe("ContainerHealthRunnerService write volume", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const STARTED = new Date("2026-10-30T00:00:00Z"); // the inspect fixtures' StartedAt
  const same = (over: Record<string, unknown> = {}) => prevRow({ startedAt: STARTED, ...over });

  it("an unchanged container costs NO write on a steady tick (no upsert, no delete, no refresh while fresh)", async () => {
    const { svc, upsert, deleteMany, updateMany, update } = make({ rows: [same({ updatedAt: ago(30_000) })], output: inspectOut(0) });
    await svc.runTick();
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps unchanged rows inside reduceHealth's 180 s freshness window with ONE statement per server, not one upsert per container", async () => {
    const rows = [same({ updatedAt: ago(100_000) }), same({ containerName: "tugra_app2", containerId: "c2", updatedAt: ago(100_000) })];
    const output = ["##INSPECT", "/tugra_app1\tc1\trunning\t0\tfalse\t0\t2026-10-30T00:00:00Z\t0001-01-01T00:00:00Z\t", "/tugra_app2\tc2\trunning\t0\tfalse\t0\t2026-10-30T00:00:00Z\t0001-01-01T00:00:00Z\t", "##EVENTS", ""].join("\n");
    const { svc, upsert, updateMany } = make({ rows, output });
    await svc.runTick();
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ serverId: "s1", containerName: { in: ["tugra_app1", "tugra_app2"] } });
    expect(arg.data.updatedAt).toBeInstanceOf(Date);
  });

  it("still upserts a row whose state CHANGED", async () => {
    const { svc, upsert } = make({ rows: [same({ updatedAt: ago(10_000) })], output: inspectHealth("starting") });
    await svc.runTick();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("skips the memory-sample read unless a running app/db with a memory limit exists", async () => {
    const none = make({ rows: [same()], output: inspectOut(0) });
    await none.svc.runTick();
    expect((none.prisma as any).containerMetric.findMany).not.toHaveBeenCalled();
    const limited = make({ rows: [prevRow()], output: inspectOut(0), apps: [{ id: "app1", name: "Shop", status: "RUNNING", memoryMb: 512 }] });
    await limited.svc.runTick();
    const q = (limited.prisma as any).containerMetric.findMany.mock.calls[0][0];
    expect(q.where.containerName).toEqual({ in: ["tugra_app1"] }); // only the candidate, never every container
  });

  it("loads previous states, apps and databases ONCE per tick for the whole fleet", async () => {
    const servers = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, teamId: "t1", hostname: null }));
    const { svc, prisma } = make({ servers, rows: [] });
    await svc.runTick();
    const p = prisma as any;
    expect(p.containerState.findMany).toHaveBeenCalledTimes(1);
    expect(p.application.findMany).toHaveBeenCalledTimes(1);
    expect(p.database.findMany).toHaveBeenCalledTimes(1);
  });

  it("polls servers with bounded parallelism (4 at a time, not 50 in a row, not 50 at once)", async () => {
    const servers = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, teamId: "t1", hostname: null }));
    const { svc, sendCommand } = make({ servers, rows: [], delayMs: 10 });
    let active = 0;
    let max = 0;
    const inner = sendCommand.getMockImplementation()!;
    sendCommand.mockImplementation(async (...a: unknown[]) => {
      active++;
      max = Math.max(max, active);
      try {
        return await (inner as (...x: unknown[]) => Promise<unknown>)(...a);
      } finally {
        active--;
      }
    });
    await svc.runTick();
    expect(sendCommand).toHaveBeenCalledTimes(12);
    expect(max).toBe(4);
  });
});
