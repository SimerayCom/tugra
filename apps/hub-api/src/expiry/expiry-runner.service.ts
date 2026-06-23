import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { probeSsl, type SslStatus } from "../applications/ssl-probe";

/**
 * Daily check that proactively warns (via notification channels) when an SSL
 * certificate or an API token is about to expire. Dedup is stateless: a warning
 * fires only when the remaining-days count lands exactly on a threshold, so the
 * daily job emits at most one alert per threshold per resource — no extra table.
 */
const NOTIFY_DAYS = [14, 7, 3, 1];

@Injectable()
export class ExpiryRunnerService {
  private readonly logger = new Logger(ExpiryRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  daysUntil(date: Date): number {
    return Math.floor((date.getTime() - Date.now()) / 86_400_000);
  }

  shouldNotify(days: number): boolean {
    return NOTIFY_DAYS.includes(days);
  }

  /** Wrapper so tests can stub the outbound TLS probe. */
  probeDomain(host: string): Promise<SslStatus> {
    return probeSsl(host);
  }

  async runChecks(): Promise<void> {
    await this.checkSsl().catch((e) => this.logger.warn(`ssl check failed: ${e}`));
    await this.checkTokens().catch((e) => this.logger.warn(`token check failed: ${e}`));
  }

  async checkSsl(): Promise<void> {
    const apps = await this.prisma.application.findMany({ where: { domain: { not: null } } });
    for (const app of apps) {
      const ssl = await this.probeDomain(app.domain!);
      const days = ssl.daysRemaining;
      if (days == null || !this.shouldNotify(days)) continue;
      await this.notifications
        .fireForEvent(app.teamId, "ssl_expiring", `⚠️ SSL for ${app.domain} expires in ${days} day(s)`)
        .catch(() => {});
    }
  }

  async checkTokens(): Promise<void> {
    const tokens = await this.prisma.apiToken.findMany({ where: { expiresAt: { not: null } } });
    for (const token of tokens) {
      const days = this.daysUntil(token.expiresAt!);
      if (!this.shouldNotify(days)) continue;
      const memberships = await this.prisma.membership.findMany({ where: { userId: token.userId } });
      for (const m of memberships) {
        await this.notifications
          .fireForEvent(m.teamId, "token_expiring", `⚠️ API token "${token.name}" expires in ${days} day(s)`)
          .catch(() => {});
      }
    }
  }
}
