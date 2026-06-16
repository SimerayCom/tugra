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
  ...over,
});

describe("MonitorRunnerService — METRIC", () => {
  it("goes DOWN and notifies when disk usage exceeds the threshold", async () => {
    const { svc, fire } = make(metricMonitor(), {
      cpu: 10, memUsed: 1, memTotal: 10, diskUsed: 92, diskTotal: 100,
    });
    const out = await svc.runCheck("m1");
    expect(out?.status).toBe("DOWN");
    expect(out?.important).toBe(true);
    expect(fire).toHaveBeenCalled();
  });

  it("stays UP when usage is below the threshold", async () => {
    const { svc, fire } = make(metricMonitor(), {
      cpu: 10, memUsed: 1, memTotal: 10, diskUsed: 40, diskTotal: 100,
    });
    const out = await svc.runCheck("m1");
    expect(out?.status).toBe("UP");
    expect(fire).not.toHaveBeenCalled();
  });

  it("no metrics yet → UP (no false alarm)", async () => {
    const { svc } = make(metricMonitor(), null);
    const out = await svc.runCheck("m1");
    expect(out?.status).toBe("UP");
  });
});
