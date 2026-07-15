import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { checkers, metricCheckResult, type MetricKind } from "./checkers";
import { nextState } from "./transition";

export interface CheckOutcome {
  status: string;
  ms: number;
  msg: string;
  important: boolean;
}

@Injectable()
export class MonitorRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async runCheck(monitorId: string): Promise<CheckOutcome | null> {
    const m = await this.prisma.monitor.findUnique({ where: { id: monitorId } });
    if (!m) return null;

    let r;
    if (m.type === "METRIC") {
      const row = m.serverId
        ? await this.prisma.metric.findFirst({
            where: { serverId: m.serverId },
            orderBy: { ts: "desc" },
          })
        : null;
      const sample = row
        ? {
            cpu: row.cpu,
            memUsed: Number(row.memUsed),
            memTotal: Number(row.memTotal),
            diskUsed: Number(row.diskUsed),
            diskTotal: Number(row.diskTotal),
          }
        : null;
      r = metricCheckResult((m.metric as MetricKind) ?? "DISK", sample, m.thresholdPct ?? 90);
    } else {
      r = await checkers[m.type](m);
    }
    const t = nextState(
      { status: m.status, failCount: m.failCount, downCount: m.downCount },
      r.up,
      { retries: m.retries, resendEvery: m.resendEvery },
    );

    await this.prisma.heartbeat.create({
      data: {
        monitorId: m.id,
        status: t.status,
        ms: r.ms,
        msg: r.msg,
        important: t.important,
      },
    });
    await this.prisma.monitor.update({
      where: { id: m.id },
      data: { status: t.status, failCount: t.failCount, downCount: t.downCount },
    });

    if (t.important) {
      // The service derives monitor_up/monitor_down from ctx.status to select the template.
      await this.notifications.fireForMonitor(m.id, {
        status: t.status,
        monitorId: m.id,
        monitorName: m.name,
        target: m.target,
        monitorType: m.type,
        resultMsg: r.msg,
        responseMs: r.ms,
        teamId: m.teamId,
      });
    }

    return { status: t.status, ms: r.ms, msg: r.msg, important: t.important };
  }
}
