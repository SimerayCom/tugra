import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { NotificationsService } from "../notifications/notifications.service";
import { assertPingUrl, pingHostHint, pingOnce, type PingResult } from "./hub-deadman-ping";
import type { HubDeadmanInput } from "./dto";

export interface HubDeadmanView {
  enabled: boolean;
  intervalMinutes: number;
  urlSet: boolean;
  /** Host of the check-in address only (the rest is a secret token). */
  urlHost: string | null;
  lastPingAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  failStreak: number;
}

/** A missed-tick gap is an outage once it exceeds this many intervals. */
export const GAP_INTERVALS = 3;
/** Consecutive failed check-ins before the hub says so itself. */
export const FAIL_ALERT_STREAK = 3;

/**
 * The hub's dead-man check-in. The hub cannot announce its own death, so it pings an address OUTSIDE itself on an
 * interval (any push monitor works: another Tugra hub, an uptime service, a status tool) and that side alerts when the
 * pings stop. What the hub CAN do is say so itself afterwards: a gap in its own ticks means it was down, and a check-in
 * address it cannot reach is worth a notice. Both go through the normal notification channels of the local server's team.
 */
@Injectable()
export class HubDeadmanService {
  private readonly logger = new Logger(HubDeadmanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The transport; a spec swaps it (the real one is SSRF-pinned). */
  ping: (url: string) => Promise<PingResult> = pingOnce;

  private async row() {
    return this.prisma.hubDeadmanConfig.findUnique({ where: { id: "singleton" } });
  }

  private plainUrl(enc: string | null | undefined): string | null {
    if (!enc) return null;
    try {
      return this.crypto.decrypt(enc);
    } catch {
      return null;
    }
  }

  async get(): Promise<HubDeadmanView> {
    const c = await this.row();
    const url = this.plainUrl(c?.urlEnc);
    return {
      enabled: c?.enabled ?? false,
      intervalMinutes: c?.intervalMinutes ?? 5,
      urlSet: !!c?.urlEnc,
      urlHost: url ? pingHostHint(url) : null,
      lastPingAt: c?.lastPingAt?.toISOString() ?? null,
      lastOkAt: c?.lastOkAt?.toISOString() ?? null,
      lastError: c?.lastError ?? null,
      failStreak: c?.failStreak ?? 0,
    };
  }

  /** `url` absent keeps the stored address, `null` clears it. */
  async update(userId: string, input: HubDeadmanInput): Promise<HubDeadmanView> {
    const prev = await this.row();
    let urlEnc = prev?.urlEnc ?? null;
    if (input.url !== undefined) {
      if (input.url === null) urlEnc = null;
      else {
        try {
          assertPingUrl(input.url);
        } catch (e) {
          throw new BadRequestException(e instanceof Error ? e.message : "invalid URL");
        }
        urlEnc = this.crypto.encrypt(input.url);
      }
    }
    if (input.enabled && !urlEnc) throw new BadRequestException("a check-in address is required to turn this on");
    // Turning it on after it was off starts a fresh clock: the switched-off time is not an outage.
    const turnedOn = input.enabled && !prev?.enabled;
    const data = {
      enabled: input.enabled,
      intervalMinutes: input.intervalMinutes,
      urlEnc,
      ...(input.url !== undefined ? { failStreak: 0, alertedAt: null, lastError: null } : {}),
      ...(turnedOn ? { lastTickAt: null, lastPingAt: null } : {}),
    };
    await this.prisma.hubDeadmanConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
    await this.audit.log({ actor: userId, action: "hub.deadman.config", target: "hub" });
    return this.get();
  }

  /** One immediate check-in so the owner sees at setup time that the address works. Does not touch the streak. */
  async test(): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const url = this.plainUrl((await this.row())?.urlEnc);
    if (!url) throw new BadRequestException("no check-in address saved");
    const r = await this.ping(url);
    return { ok: r.ok, status: r.status, error: r.error };
  }

  /** The team that receives hub-level notices: the local ("This machine") server's. */
  private async noticeTeamId(): Promise<string | null> {
    const local = await this.prisma.server.findFirst({ where: { isLocal: true }, select: { teamId: true } });
    return local?.teamId ?? null;
  }

  /** One scheduler tick (every minute): detect our own downtime, check in when due, and say so when the check-in keeps failing. */
  async tick(now: Date = new Date()): Promise<void> {
    const c = await this.row();
    if (!c?.enabled) return;
    const url = this.plainUrl(c.urlEnc);
    const teamId = await this.noticeTeamId();
    const gapMs = c.lastTickAt ? now.getTime() - c.lastTickAt.getTime() : 0;
    const gapOutage = !!c.lastTickAt && gapMs > GAP_INTERVALS * c.intervalMinutes * 60_000;

    // The scheduler ticks every minute; a check-in only goes out when one is due (the gap above is judged first).
    const due = !c.lastPingAt || now.getTime() - c.lastPingAt.getTime() >= c.intervalMinutes * 60_000 - 5_000 || gapOutage;
    if (!due) {
      await this.prisma.hubDeadmanConfig.update({ where: { id: "singleton" }, data: { lastTickAt: now } });
      return;
    }
    let result: PingResult = { ok: false, status: null, error: "no-url" };
    if (url) result = await this.ping(url);
    const failStreak = result.ok ? 0 : c.failStreak + 1;
    const alertNow = !result.ok && failStreak >= FAIL_ALERT_STREAK && !c.alertedAt;
    await this.prisma.hubDeadmanConfig.update({
      where: { id: "singleton" },
      data: {
        lastTickAt: now,
        lastPingAt: now,
        ...(result.ok ? { lastOkAt: now, lastError: null, alertedAt: null } : { lastError: result.error ?? "failed", ...(alertNow ? { alertedAt: now } : {}) }),
        failStreak,
      },
    });
    if (!teamId) return;
    if (gapOutage) {
      await this.notifications.fireForEvent(teamId, "hub_outage", { kind: "gap", minutes: String(Math.round(gapMs / 60_000)) }).catch((e) => this.logger.warn(`hub outage notice failed: ${e instanceof Error ? e.message : e}`));
    }
    if (alertNow) {
      await this.notifications.fireForEvent(teamId, "hub_outage", { kind: "failing", failures: String(failStreak) }).catch((e) => this.logger.warn(`hub outage notice failed: ${e instanceof Error ? e.message : e}`));
    }
  }
}
