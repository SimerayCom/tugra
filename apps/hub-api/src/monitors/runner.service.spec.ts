import { MonitorRunnerService } from "./runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

function make(monitor: Record<string, unknown>, latestMetric: Record<string, unknown> | null) {
  const fire = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    monitor: {
      findUnique: jest.fn().mockResolvedValue(monitor),
      update: jest.fn().mockResolvedValue({}),
    },
    metric: { findFirst: jest.fn().mockResolvedValue(latestMetric) },
    heartbeat: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as PrismaService;
  const notifications = { fireForMonitor: fire } as unknown as NotificationsService;
  return { svc: new MonitorRunnerService(prisma, notifications), fire };
}

const metricMonitor = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "disk-watch",
  type: "METRIC",
  target: "DISK",
  serverId: "s1",
  metric: "DISK",
  thresholdPct: 80,
  status: "UP",
  failCount: 0,
  downCount: 0,
  retries: 0,
  resendEvery: 0,
  createdAt: new Date(), // recent by default → a null-row monitor is "no metrics yet" (first-run grace)
  ...over,
});

describe("MonitorRunnerService — METRIC", () => {
  it("goes DOWN and notifies when disk usage exceeds the threshold", async () => {
    const { svc, fire } = make(metricMonitor(), {
      cpu: 10, memUsed: 1, memTotal: 10, diskUsed: 92, diskTotal: 100, ts: new Date(),
    });
    const out = await svc.runCheck("m1");
    expect(out?.status).toBe("DOWN");
    expect(out?.important).toBe(true);
    expect(fire).toHaveBeenCalled();
  });

  it("stays UP when usage is below the threshold", async () => {
    const { svc, fire } = make(metricMonitor(), {
      cpu: 10, memUsed: 1, memTotal: 10, diskUsed: 40, diskTotal: 100, ts: new Date(),
    });
    const out = await svc.runCheck("m1");
    expect(out?.status).toBe("UP");
    expect(fire).not.toHaveBeenCalled();
  });

  it("an ESTABLISHED UP monitor with no fresh row goes down — not stuck UP (F03)", async () => {
    const { svc } = make(metricMonitor({ status: "UP", createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) }), null);
    const out = await svc.runCheck("m1");
    expect(out?.status).not.toBe("UP"); // an old monitor can't stay UP on no data (silent agent / retention purge)
  });

  it("a JUST-CREATED PENDING monitor with no metrics stays UP — first-run grace (matches monitors.e2e)", async () => {
    // A fresh monitor defaults to PENDING and may not have a sample yet; the freshness gate must NOT alarm it.
    const { svc, fire } = make(metricMonitor({ status: "PENDING", createdAt: new Date() }), null);
    const out = await svc.runCheck("m1");
    expect(out?.status).toBe("UP");
    expect(fire).not.toHaveBeenCalled();
  });

  it("no metrics yet → UP (no false alarm)", async () => {
    const { svc } = make(metricMonitor(), null);
    const out = await svc.runCheck("m1");
    expect(out?.status).toBe("UP");
  });

  it("a STALE low sample does NOT recover a DOWN monitor to UP (F03)", async () => {
    const { svc, fire } = make(metricMonitor({ status: "DOWN" }), {
      cpu: 1, memUsed: 1, memTotal: 10, diskUsed: 10, diskTotal: 100, // well below the 80% threshold
      ts: new Date(Date.now() - 60 * 60 * 1000), // 1h old → far past maxAge (~90s)
    });
    const out = await svc.runCheck("m1");
    expect(out?.status).not.toBe("UP"); // the stale row must not flip DOWN→UP
    expect(fire).not.toHaveBeenCalled(); // and never a false "recovered" notification
  });

  it("a FRESH low sample DOES recover a DOWN monitor (regression guard — the gate must not block real recovery)", async () => {
    const { svc, fire } = make(metricMonitor({ status: "DOWN" }), {
      cpu: 1, memUsed: 1, memTotal: 10, diskUsed: 10, diskTotal: 100,
      ts: new Date(Date.now() - 5000), // 5s old → fresh
    });
    const out = await svc.runCheck("m1");
    expect(out?.status).toBe("UP");
    expect(out?.important).toBe(true);
    expect(fire).toHaveBeenCalled();
  });

  it("an ABSENT row does not recover an already-DOWN monitor (48h retention purge) (F03)", async () => {
    const { svc, fire } = make(metricMonitor({ status: "DOWN" }), null);
    const out = await svc.runCheck("m1");
    expect(out?.status).not.toBe("UP");
    expect(fire).not.toHaveBeenCalled();
  });

  it("a FUTURE-dated sample (agent clock skew) is treated as stale, not a recovery (F03)", async () => {
    const { svc, fire } = make(metricMonitor({ status: "DOWN" }), {
      cpu: 1, memUsed: 1, memTotal: 10, diskUsed: 10, diskTotal: 100,
      ts: new Date(Date.now() + 60 * 60 * 1000), // 1h in the future
    });
    const out = await svc.runCheck("m1");
    expect(out?.status).not.toBe("UP");
    expect(fire).not.toHaveBeenCalled();
  });
});
