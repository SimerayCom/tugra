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
      const now = Date.now();
      // A sample older than ~3 check intervals (min 90s for scheduler jitter + agent report cadence) can't
      // confirm current health → treated as a failure, never a recovery.
      const maxAgeMs = Math.max(3 * (m.intervalSec ?? 30) * 1000, 90_000);
      const row = m.serverId
        ? await this.prisma.metric.findFirst({
            // `ts` is the agent's clock: exclude a future-dated row so a single clock-skewed sample can't sort
            // first and shadow the real, fresh rows (which would wedge the monitor DOWN until real time passes).
            where: { serverId: m.serverId, ts: { lte: new Date(now + 60_000) } },
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
      // "no metrics yet" (UP) is a grace ONLY for a genuinely NEW monitor (a fresh monitor defaults to PENDING
      // and may not have a sample yet — don't false-alarm it). An absent row fails the check when the monitor
      // is already DOWN (don't recover from no data) OR is ESTABLISHED (older than maxAge): that covers the
      // windows a DOWN-only check missed — disabled→re-enabled, a deleted server, the retention purge, and a
      // long PENDING ladder — without breaking a just-created monitor's grace.
      const established = m.createdAt ? now - new Date(m.createdAt).getTime() > maxAgeMs : false;
      r = metricCheckResult((m.metric as MetricKind) ?? "DISK", sample, m.thresholdPct ?? 90, {
        ts: row?.ts,
        now,
        maxAgeMs,
        noDataIsDown: m.status === "DOWN" || established,
      });
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
