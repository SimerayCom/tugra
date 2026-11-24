import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { MailService } from "../mail/mail.service";
import { statusConfirmEmail, statusUpdateEmail } from "../mail/templates";
import { webBaseUrl } from "../common/web-url";

const MAX_SUBSCRIBERS_PER_PAGE = 5000;

type TokenKind = "confirm" | "unsub";

/**
 * Email updates for a public status page (only while the hub has mail configured). Double opt-in; the confirm and
 * unsubscribe tokens are keyed MACs of the subscriber id (`<id>.<mac>`), so nothing secret is stored and a token
 * can't be forged without the hub's key. Sending is fire-and-forget and never blocks or fails the monitor runner.
 */
@Injectable()
export class StatusSubscribersService {
  private readonly logger = new Logger(StatusSubscribersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  emailAvailable(): boolean {
    return this.mail.isConfigured();
  }

  token(kind: TokenKind, id: string): string {
    return `${id}.${this.crypto.hmac(`status:${kind}:${id}`)}`;
  }

  /** The subscriber id a token is valid for, or null (malformed / forged / wrong kind). */
  verifyToken(kind: TokenKind, token: string): string | null {
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const id = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1));
    const ok = this.crypto.hmacCandidates(`status:${kind}:${id}`).some((c) => {
      const want = Buffer.from(c);
      return want.length === mac.length && timingSafeEqual(want, mac);
    });
    return ok ? id : null;
  }

  private pageUrl(slug: string): string {
    return `${webBaseUrl(this.config)}/status/${slug}`;
  }

  private actionUrl(slug: string, action: "confirm" | "unsubscribe", token: string): string {
    return `${this.pageUrl(slug)}/email?action=${action}&token=${encodeURIComponent(token)}`;
  }

  /** Start a subscription. Always the same answer for a known / unknown address (no enumeration). */
  async subscribe(slug: string, email: string): Promise<void> {
    const page = await this.prisma.statusPage.findFirst({ where: { slug, enabled: true }, select: { id: true, title: true, slug: true } });
    if (!page) throw new NotFoundException("status page not found");
    if (!this.mail.isConfigured()) throw new ConflictException("email updates are not available");
    const existing = await this.prisma.statusSubscriber.findUnique({ where: { pageId_email: { pageId: page.id, email } } });
    if (existing?.confirmedAt) return;
    if (!existing && (await this.prisma.statusSubscriber.count({ where: { pageId: page.id } })) >= MAX_SUBSCRIBERS_PER_PAGE) {
      throw new ConflictException("this page has reached its subscriber limit");
    }
    const row = existing ?? (await this.prisma.statusSubscriber.create({ data: { pageId: page.id, email } }));
    const confirmUrl = this.actionUrl(page.slug, "confirm", this.token("confirm", row.id));
    await this.mail.send(email, statusConfirmEmail({ title: page.title, confirmUrl }));
  }

  async confirm(token: string): Promise<{ slug: string }> {
    const id = this.verifyToken("confirm", token);
    const row = id ? await this.prisma.statusSubscriber.findUnique({ where: { id }, include: { page: { select: { slug: true } } } }) : null;
    if (!row) throw new NotFoundException("this link is no longer valid");
    if (!row.confirmedAt) await this.prisma.statusSubscriber.update({ where: { id: row.id }, data: { confirmedAt: new Date() } });
    return { slug: row.page.slug };
  }

  async unsubscribe(token: string): Promise<{ slug: string }> {
    const id = this.verifyToken("unsub", token);
    const row = id ? await this.prisma.statusSubscriber.findUnique({ where: { id }, include: { page: { select: { slug: true } } } }) : null;
    if (!row) throw new NotFoundException("this link is no longer valid");
    await this.prisma.statusSubscriber.delete({ where: { id: row.id } });
    return { slug: row.page.slug };
  }

  async counts(pageId: string): Promise<{ confirmed: number; pending: number }> {
    const [confirmed, pending] = await Promise.all([
      this.prisma.statusSubscriber.count({ where: { pageId, confirmedAt: { not: null } } }),
      this.prisma.statusSubscriber.count({ where: { pageId, confirmedAt: null } }),
    ]);
    return { confirmed, pending };
  }

  /** A chosen monitor changed state (called by the monitor runner on the important UP<->DOWN edges). */
  async notifyMonitor(monitorId: string, status: "UP" | "DOWN"): Promise<void> {
    if (!this.mail.isConfigured()) return;
    const links = await this.prisma.statusPageMonitor.findMany({
      where: { monitorId, page: { enabled: true, subscribers: { some: { confirmedAt: { not: null } } } } },
      include: { monitor: { select: { name: true } }, page: { select: { id: true, slug: true, title: true } } },
    });
    for (const l of links) {
      const name = l.label ?? l.monitor.name;
      await this.broadcast(l.page, status === "DOWN" ? `${name} is having issues` : `${name} is back up`, null);
    }
  }

  /** A maintenance window was announced. */
  async notifyMaintenance(page: { id: string; slug: string; title: string }, m: { title: string; body: string | null; startsAt: Date; endsAt: Date }): Promise<void> {
    if (!this.mail.isConfigured()) return;
    const when = `${m.startsAt.toISOString().slice(0, 16).replace("T", " ")} to ${m.endsAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    await this.broadcast(page, `Planned maintenance: ${m.title}`, m.body ? `${when}\n${m.body}` : when);
  }

  private async broadcast(page: { id: string; slug: string; title: string }, headline: string, detail: string | null): Promise<void> {
    const subs = await this.prisma.statusSubscriber.findMany({ where: { pageId: page.id, confirmedAt: { not: null } }, select: { id: true, email: true } });
    for (const s of subs) {
      try {
        await this.mail.send(
          s.email,
          statusUpdateEmail({
            title: page.title,
            headline,
            detail,
            pageUrl: this.pageUrl(page.slug),
            unsubscribeUrl: this.actionUrl(page.slug, "unsubscribe", this.token("unsub", s.id)),
          }),
        );
      } catch (e) {
        this.logger.warn(`status update email failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
