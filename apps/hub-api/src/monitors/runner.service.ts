import { Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CryptoService } from "../crypto/crypto.service";
import { applyUpsideDown, checkers, isPctMetric, metricCheckResult, type HttpOptions, type MetricKind } from "./checkers";
import { nextState } from "./transition";
import { StatusSubscribersService } from "../status-page/status-subscribers.service";

export interface CheckOutcome {
  status: string;
  ms: number;
  msg: string;
  important: boolean;
  cause?: string | null;
}

/** Decrypt a monitor's request options; a value that cannot be opened degrades to "no options" (the check then
 *  fails visibly on auth) rather than breaking the whole scheduler. */
function readOptions(crypto: CryptoService, enc: string | null | undefined): HttpOptions | undefined {
  if (!enc) return undefined;
  try {
    return JSON.parse(crypto.decrypt(enc)) as HttpOptions;
  } catch {
    return undefined;
  }
}

@Injectable()
export class MonitorRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly crypto: CryptoService,
    // Email updates for a public status page that lists this monitor (only does anything while mail is configured).
    @Optional() private readonly statusSubscribers?: StatusSubscribersService,
  ) {}

  /** `manual` = an explicit "check now" from a user, which is allowed on a paused monitor; the scheduler is not. */
  async runCheck(monitorId: string, opts: { manual?: boolean } = {}): Promise<CheckOutcome | null> {
    const m = await this.prisma.monitor.findUnique({ where: { id: monitorId } });
    if (!m) return null;
    if (m.enabled === false && !opts.manual) return null; // paused: never check or alert

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
            load1: row.load1,
            load5: row.load5,
            load15: row.load15,
            temp: row.temp,
            netBps: Number(row.netRx) + Number(row.netTx),
          }
        : null;
      // "no metrics yet" (UP) is a grace ONLY for a genuinely NEW monitor (a fresh monitor defaults to PENDING
      // and may not have a sample yet — don't false-alarm it). An absent row fails the check when the monitor
      // is already DOWN (don't recover from no data) OR is ESTABLISHED (older than maxAge): that covers the
      // windows a DOWN-only check missed — disabled→re-enabled, a deleted server, the retention purge, and a
      // long PENDING ladder — without breaking a just-created monitor's grace.
      const established = m.createdAt ? now - new Date(m.createdAt).getTime() > maxAgeMs : false;
      const kind = (m.metric as MetricKind) ?? "DISK";
      // Percent kinds read thresholdPct; load / temperature / bandwidth read thresholdValue.
      const limit = isPctMetric(kind) ? (m.thresholdPct ?? 90) : (m.thresholdValue ?? m.thresholdPct ?? 90);
      r = metricCheckResult(kind, sample, limit, {
        ts: row?.ts,
        now,
        maxAgeMs,
        noDataIsDown: m.status === "DOWN" || established,
      });
    } else {
      const checker = checkers[m.type];
      r = checker
        ? await checker(m, readOptions(this.crypto, m.httpOptionsEnc))
        : { up: false, ms: 0, msg: `unsupported monitor type ${m.type}` };
      if (m.upsideDown) r = applyUpsideDown(r);
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
        cause: r.cause ?? null,
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
        cause: r.cause ?? undefined,
        responseMs: r.ms,
        teamId: m.teamId,
      });
      // Only the real edges (first DOWN, recovery) — a long DOWN's resend beats must not re-email subscribers.
      if ((t.status === "UP" || t.status === "DOWN") && t.status !== m.status) {
        void this.statusSubscribers?.notifyMonitor(m.id, t.status).catch(() => undefined);
      }
    }

    return { status: t.status, ms: r.ms, msg: r.msg, important: t.important, cause: r.cause ?? null };
  }
}
