import { ContainerHealthRunnerService } from "./container-health.runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

const SERVER = { id: "s1", name: "box", teamId: "t1", hostname: "box.local" };

// inspect output: one app container; `restartCount` + extra event lines overridable
function inspectOut(restartCount: number, extra = "") {
  return ["##INSPECT", `/tugra_app1\tc1\trunning\t0\tfalse\t${restartCount}\t2026-10-30T00:00:00Z\t0001-01-01T00:00:00Z\t`, "##EVENTS", extra].join("\n");
}

function make(opts: { rows?: unknown[]; online?: boolean; output?: string; exitCode?: number; apps?: unknown[]; metrics?: unknown[] } = {}) {
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const upsert = jest.fn().mockResolvedValue({});
  const update = jest.fn().mockResolvedValue({});
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const create = jest.fn().mockResolvedValue({});
  const prisma = {
    server: { findMany: jest.fn().mockResolvedValue([SERVER]) },
    containerState: { findMany: jest.fn().mockResolvedValue(opts.rows ?? []), upsert, update, deleteMany },
    containerEvent: { create },
    containerMetric: { findMany: jest.fn().mockResolvedValue(opts.metrics ?? []) },
    application: { findMany: jest.fn().mockResolvedValue(opts.apps ?? [{ id: "app1", name: "Shop", status: "RUNNING" }]) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  // The poll command returns the inspect/events output; a later `docker logs` fetch returns a canned tail.
  const sendCommand = jest.fn().mockImplementation((_id: string, cmd: string) =>
    Promise.resolve(
      cmd.includes("docker logs")
        ? { exitCode: 0, output: "2026-10-30T00:00:01Z panic: boom\n" }
        : { exitCode: opts.exitCode ?? 0, output: opts.output ?? inspectOut(0) },
    ),
  );
  const agentWs = { isOnline: jest.fn().mockReturnValue(opts.online ?? true), sendCommand } as unknown as AgentWsServer;
  const notifications = { fireForEvent } as unknown as NotificationsService;
  return { svc: new ContainerHealthRunnerService(prisma, agentWs, notifications), fireForEvent, upsert, update, deleteMany, create, sendCommand };
}

const prevRow = (over: Record<string, unknown> = {}) => ({
  serverId: "s1", containerName: "tugra_app1", containerId: "c1", status: "running", exitCode: 0, oomKilled: false,
  restartCount: 0, startedAt: null, finishedAt: null, health: null, lastEventTs: 0n,
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
    await expect(svc.runTick()).resolves.toBeUndefined();
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
    const { svc, create, deleteMany } = make({ rows: [prevRow({ restartCount: 2, restartCountAtNotify: 2 })], output: inspectOut(3) });
    create.mockRejectedValueOnce(new Error("23502 bad byte"));
    await expect(svc.runTick()).resolves.toBeUndefined();
    expect(deleteMany).toHaveBeenCalled(); // the tick ran to completion past the failed row
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
