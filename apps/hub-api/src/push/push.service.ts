import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { webBaseUrl } from "../common/web-url";
import { HttpStatusError, SsrfError, assertSafeUrl, safeSend } from "../notifications/safe-url";
import { setPushDelegate, type ChannelConfig } from "../notifications/providers";
import type { RenderedMessage } from "../notifications/rendered-message";
import type { SubscribePushInput } from "./dto";
import {
  MAX_PAYLOAD_BYTES,
  buildWebPushRequest,
  generateVapidKeys,
  isValidSubscriptionKeys,
  vapidPairMatches,
  type VapidKeys,
} from "./webpush";

/** A user keeps at most this many devices; the oldest are dropped first (a browser that re-subscribes forever). */
export const MAX_DEVICES_PER_USER = 20;

export interface PushDeviceView {
  id: string;
  deviceLabel: string | null;
  /** Which push service holds the subscription (the origin only: the full endpoint URL is a capability). */
  service: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** The notification the service worker renders. Kept small: one encrypted record is at most ~4 KB. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap should go: an absolute URL on the panel origin, or "/". The service worker re-checks the origin. */
  url: string;
  /** Collapses repeats of the same event on the device. */
  tag: string;
  level: string;
}

export interface PushSendResult {
  sent: number;
  removed: number;
  failed: number;
}

/** First line of an error that is safe to keep in the delivery history. */
function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly settings: InstanceSettingsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // The provider registry is DI-less; this is how the "push" channel type reaches the database.
    setPushDelegate({ deliver: (cfg, msg) => this.deliverChannel(cfg, msg) });
  }

  // ---- VAPID keys ----

  /** The hub's application-server key pair, generated on first use (race-safe: the loser re-reads the winner's). */
  async vapidKeys(): Promise<VapidKeys> {
    const read = async (): Promise<VapidKeys | null> => {
      const s = await this.settings.get();
      if (!s.vapidPublicKey || !s.vapidPrivateKeyEnc) return null;
      return { publicKey: s.vapidPublicKey, privateKeyPem: this.crypto.decrypt(s.vapidPrivateKeyEnc) };
    };
    const have = await read();
    if (have) return have;
    const gen = generateVapidKeys();
    await this.prisma.instanceSettings.updateMany({
      where: { id: "singleton", vapidPrivateKeyEnc: null },
      data: { vapidPublicKey: gen.publicKey, vapidPrivateKeyEnc: this.crypto.encrypt(gen.privateKeyPem) },
    });
    const now = await read();
    if (!now || !vapidPairMatches(now)) throw new Error("could not persist the Web Push key pair");
    return now;
  }

  async publicKey(): Promise<string> {
    return (await this.vapidKeys()).publicKey;
  }

  /** The VAPID `sub` claim: a contact the push service can reach. https panel URL, else the ACME email, else a placeholder. */
  private async subject(): Promise<string> {
    const base = webBaseUrl(this.config);
    if (base.startsWith("https://")) return base;
    const email = (await this.settings.get()).acmeEmail;
    return email ? `mailto:${email}` : "mailto:admin@localhost";
  }

  // ---- devices ----

  private deviceView(d: { id: string; deviceLabel: string | null; endpoint: string; createdAt: Date; lastUsedAt: Date | null }): PushDeviceView {
    let service = "";
    try {
      service = new URL(d.endpoint).host;
    } catch {
      /* stored endpoints were validated; an unparseable one just shows blank */
    }
    return { id: d.id, deviceLabel: d.deviceLabel, service, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt };
  }

  async list(userId: string): Promise<PushDeviceView[]> {
    const rows = await this.prisma.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => this.deviceView(r));
  }

  /** Register (or re-register) this browser for the signed-in user. The same endpoint always maps to one row. */
  async subscribe(userId: string, dto: SubscribePushInput): Promise<PushDeviceView> {
    const u = new URL(dto.endpoint);
    if (u.protocol !== "https:") throw new BadRequestException("push endpoint must be https");
    if (!isValidSubscriptionKeys(dto.keys.p256dh, dto.keys.auth)) throw new BadRequestException("invalid push subscription keys");
    try {
      // The hub will POST to this URL, so it gets the same SSRF policy as a webhook target, except that a
      // private-network allowance never applies: real push services are public.
      await assertSafeUrl(dto.endpoint, { allowPrivate: false });
    } catch (e) {
      if (e instanceof SsrfError) throw new BadRequestException(e.message);
      throw e;
    }
    const data = { userId, p256dh: dto.keys.p256dh, authEnc: this.crypto.encrypt(dto.keys.auth), deviceLabel: dto.deviceLabel ?? null };
    // Upsert by endpoint: signing in as someone else on the same browser moves the device to that user.
    const row = await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { endpoint: dto.endpoint, ...data },
      update: data,
    });
    const all = await this.prisma.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (all.length > MAX_DEVICES_PER_USER) {
      await this.prisma.pushSubscription.deleteMany({ where: { id: { in: all.slice(MAX_DEVICES_PER_USER).map((r) => r.id) } } });
    }
    return this.deviceView(row);
  }

  async unsubscribe(userId: string, id: string): Promise<void> {
    const r = await this.prisma.pushSubscription.deleteMany({ where: { id, userId } });
    if (r.count === 0) throw new NotFoundException("device not found");
  }

  // ---- sending ----

  /** Encrypt and POST one payload to every device of a user. Dead subscriptions (404/410) are removed on the spot. */
  async sendToUser(userId: string, payload: PushPayload, urgency: "normal" | "high" = "normal"): Promise<PushSendResult> {
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    const result: PushSendResult = { sent: 0, removed: 0, failed: 0 };
    if (!subs.length) return result;
    const keys = await this.vapidKeys();
    const subject = await this.subject();
    const bytes = this.fit(payload);
    const gone: string[] = [];
    const delivered: string[] = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          const req = buildWebPushRequest({
            endpoint: s.endpoint,
            p256dh: s.p256dh,
            auth: this.crypto.decrypt(s.authEnc),
            payload: bytes,
            subject,
            keys,
            urgency,
          });
          // safeSend re-resolves the host and dials the validated IP (rebind-safe), and never follows redirects.
          await safeSend(s.endpoint, req.body, req.headers, { allowPrivate: false });
          delivered.push(s.id);
          result.sent++;
        } catch (e) {
          if (e instanceof HttpStatusError && (e.status === 404 || e.status === 410)) {
            gone.push(s.id); // the browser unsubscribed or the subscription expired
            result.removed++;
          } else {
            result.failed++;
            this.logger.warn(`push to device ${s.id} failed: ${clip(reason(e), 120)}`); // never the endpoint or keys
          }
        }
      }),
    );
    if (gone.length) await this.prisma.pushSubscription.deleteMany({ where: { id: { in: gone } } }).catch(() => undefined);
    if (delivered.length) {
      await this.prisma.pushSubscription.updateMany({ where: { id: { in: delivered } }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return result;
  }

  /** Shrink a payload until it fits one record (long summaries are the only thing that can overflow). */
  private fit(p: PushPayload): Buffer {
    let body = p.body;
    let buf = Buffer.from(JSON.stringify({ ...p, body }));
    while (buf.length > MAX_PAYLOAD_BYTES && body.length > 1) {
      body = body.slice(0, Math.floor(body.length * 0.8));
      buf = Buffer.from(JSON.stringify({ ...p, body: body + "…" }));
    }
    if (buf.length > MAX_PAYLOAD_BYTES) throw new BadRequestException("push payload too large");
    return buf;
  }

  /** "Send a test" from the device list: tells the user whether anything arrived. */
  async test(userId: string, payload: PushPayload): Promise<PushSendResult> {
    const r = await this.sendToUser(userId, payload, "high");
    if (r.sent + r.removed + r.failed === 0) throw new ConflictException("no devices registered");
    return r;
  }

  /**
   * The "push" notification channel. The channel's stored config is server-written ({userId, teamId}); the recipient must
   * still be a member of the channel's team, so removing someone from a team silences their pushes at once.
   */
  async deliverChannel(cfg: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const userId = typeof cfg.userId === "string" ? cfg.userId : "";
    const teamId = typeof cfg.teamId === "string" ? cfg.teamId : "";
    if (!userId || !teamId) throw new Error("push: channel has no recipient");
    const member = await this.prisma.membership.findFirst({ where: { userId, teamId }, select: { id: true } });
    if (!member) throw new Error("push: recipient is no longer a member of this team");
    const url = msg.links.find((l) => sameOrigin(l.url, webBaseUrl(this.config)))?.url ?? "/";
    const r = await this.sendToUser(
      userId,
      { title: clip(msg.title, 120), body: clip(msg.summary, 400), url, tag: msg.event, level: msg.level },
      msg.level === "failure" ? "high" : "normal",
    );
    if (r.sent === 0) throw new Error(r.failed + r.removed === 0 ? "push: no devices registered" : "push: no device accepted the message");
  }
}

/** True when both URLs parse and share an origin (a plain prefix check would accept `https://panel.io.evil.com`). */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
