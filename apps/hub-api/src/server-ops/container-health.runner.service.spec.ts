import { ContainerHealthRunnerService } from "./container-health.runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

const SERVER = { id: "s1", name: "box", teamId: "t1", hostname: "box.local" };

// inspect output: one app container; `restartCount` + extra event lines overridable
function inspectOut(restartCount: number, extra = "") {
  return ["##INSPECT", `/tugra_app1\tc1\trunning\t0\tfalse\t${restartCount}\t2026-10-30T00:00:00Z\t0001-01-01T00:00:00Z\t`, "##EVENTS", extra].join("\n");
}

function make(opts: { rows?: unknown[]; online?: boolean; output?: string; exitCode?: number; apps?: unknown[] } = {}) {
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const upsert = jest.fn().mockResolvedValue({});
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    server: { findMany: jest.fn().mockResolvedValue([SERVER]) },
    containerState: { findMany: jest.fn().mockResolvedValue(opts.rows ?? []), upsert, deleteMany },
    application: { findMany: jest.fn().mockResolvedValue(opts.apps ?? [{ id: "app1", name: "Shop", status: "RUNNING" }]) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const sendCommand = jest.fn().mockResolvedValue({ exitCode: opts.exitCode ?? 0, output: opts.output ?? inspectOut(0) });
  const agentWs = { isOnline: jest.fn().mockReturnValue(opts.online ?? true), sendCommand } as unknown as AgentWsServer;
  const notifications = { fireForEvent } as unknown as NotificationsService;
  return { svc: new ContainerHealthRunnerService(prisma, agentWs, notifications), fireForEvent, upsert, deleteMany, sendCommand };
}

const prevRow = (over: Record<string, unknown> = {}) => ({
  serverId: "s1", containerName: "tugra_app1", containerId: "c1", status: "running", exitCode: 0, oomKilled: false,
  restartCount: 0, startedAt: null, finishedAt: null, health: null, lastEventTs: 0n,
  lastNotifiedKey: null, lastNotifiedAt: null, restartCountAtNotify: 0, ...over,
});

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

  it("fires container_crashed once on a restartCount increase, with resolved label/kind", async () => {
    const { svc, fireForEvent } = make({ rows: [prevRow({ restartCount: 2, restartCountAtNotify: 2 })], output: inspectOut(3) });
    await svc.runTick();
    expect(fireForEvent).toHaveBeenCalledWith("t1", "container_crashed", expect.objectContaining({ containerName: "tugra_app1", label: "Shop", kind: "app", resourceId: "app1" }));
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
});
