// Keep the SSRF validators real; only stub the HTTP transport that providers ultimately call.
jest.mock("./safe-url", () => ({ ...jest.requireActual("./safe-url"), safeSend: jest.fn() }));

import { ConfigService } from "@nestjs/config";
import { NotificationQueueService } from "./queue.service";
import { NotifI18nService } from "./notif-i18n.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { RedisService } from "../redis/redis.service";
import { safeSend } from "./safe-url";
import type { NotificationEvent } from "./event";

const mockSend = safeSend as jest.Mock;
const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
} as unknown as CryptoService;
const config = { get: () => "https://web.test" } as unknown as ConfigService;

const FAIL: NotificationEvent = { type: "deploy_failed", teamId: "t1", ctx: { appName: "blog", appId: "app1" } };
const OK: NotificationEvent = { type: "deploy_success", teamId: "t1", ctx: { appName: "blog", appId: "app1" } };

/** In-memory Redis stand-in: NX windows, counters and the held-alert ledger. */
function fakeRedis() {
  const windows = new Map<string, number>();
  const counters = new Map<string, number>();
  const ledgers = new Map<string, string[]>();
  const totals = new Map<string, number>();
  const clock = { now: 0 };
  const svc = {
    firstInWindow: jest.fn(async (key: string, ttl: number) => {
      const exp = windows.get(key);
      if (exp != null && exp > clock.now) return false;
      windows.set(key, clock.now + ttl);
      return true;
    }),
    incr: jest.fn(async (key: string) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    }),
    ledgerAdd: jest.fn(async (key: string, entry: string) => {
      ledgers.set(key, [...(ledgers.get(key) ?? []), entry]);
      totals.set(key, (totals.get(key) ?? 0) + 1);
      return totals.get(key)!;
    }),
    ledgerDrain: jest.fn(async (key: string) => {
      const out = { total: totals.get(key) ?? 0, entries: ledgers.get(key) ?? [] };
      ledgers.delete(key);
      totals.delete(key);
      return out;
    }),
  } as unknown as RedisService;
  return { svc, ledgers, advance: (s: number) => { clock.now += s; } };
}

function prismaMock(channel: Record<string, unknown>) {
  return {
    notificationDelivery: {
      create: jest.fn().mockResolvedValue({ id: "d1" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    notificationChannel: {
      findUnique: jest.fn().mockResolvedValue({ id: "c1", type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://hook" })})`, ...channel }),
    },
  } as unknown as PrismaService;
}

const make = (prisma: PrismaService, redis: RedisService, cfg: ConfigService = config) =>
  new NotificationQueueService(prisma, crypto, audit, cfg, new NotifI18nService(), redis, {} as never);
const created = (p: PrismaService) => (p.notificationDelivery.create as jest.Mock).mock.calls;

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  jest.useRealTimers();
});

describe("quiet hours", () => {
  // 02:00 UTC with a 22:00 → 07:00 UTC window
  const quiet = { quietHours: { from: "22:00", to: "07:00", tz: "UTC", allowCritical: true } };

  it("holds a non-critical alert and delivers nothing", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-24T02:00:00Z") });
    const prisma = prismaMock({ policy: quiet });
    const r = fakeRedis();
    await make(prisma, r.svc).enqueue("c1", OK);
    expect(mockSend).not.toHaveBeenCalled();
    expect(created(prisma)).toHaveLength(0);
    expect(r.svc.ledgerAdd).toHaveBeenCalledTimes(1);
    expect([...r.ledgers.keys()][0]).toBe("notifsup:c1:quiet:all");
  });

  it("lets a failure through when critical is allowed, and holds it when not", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-24T02:00:00Z") });
    const r = fakeRedis();
    const open = prismaMock({ policy: quiet });
    await make(open, r.svc).enqueue("c1", FAIL);
    expect(mockSend).toHaveBeenCalledTimes(1);

    mockSend.mockClear();
    const strict = prismaMock({ policy: { quietHours: { ...quiet.quietHours, allowCritical: false } } });
    await make(strict, r.svc).enqueue("c1", FAIL);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("delivers normally outside the window", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-24T12:00:00Z") });
    const prisma = prismaMock({ policy: quiet });
    await make(prisma, fakeRedis().svc).enqueue("c1", OK);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("the held alerts become one 'while you were away' summary on flush", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-24T02:00:00Z") });
    const prisma = prismaMock({ policy: quiet });
    const r = fakeRedis();
    const q = make(prisma, r.svc);
    await q.enqueue("c1", OK);
    await q.enqueue("c1", { ...OK, ctx: { appName: "shop", appId: "app2" } });
    await q.enqueue("c1", OK);
    await q.flush({ channelId: "c1", reason: "quiet", key: "notifsup:c1:quiet:all", teamId: "t1", windowSec: 0 });
    expect(created(prisma)).toHaveLength(1);
    expect(created(prisma)[0][0].data).toMatchObject({ event: "alert_summary", title: "While you were away" });
    const body = JSON.parse(mockSend.mock.calls[0][1]);
    expect(body.event).toBe("alert_summary");
    expect(body.summary).toBe("3 alerts were held during quiet hours.");
    expect(body.fields).toEqual(expect.arrayContaining([{ label: "Deploy succeeded — blog", value: "2×" }]));
  });

  it("an empty ledger flushes to nothing", async () => {
    const prisma = prismaMock({});
    await make(prisma, fakeRedis().svc).flush({ channelId: "c1", reason: "quiet", key: "k", teamId: "t1", windowSec: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("repeat window", () => {
  it("sends the first alert, folds the repeats into one summary with a count", async () => {
    const prisma = prismaMock({ policy: { dedupeWindowSec: 600 } });
    const r = fakeRedis();
    const q = make(prisma, r.svc);
    for (let i = 0; i < 6; i++) await q.enqueue("c1", FAIL);
    expect(mockSend).toHaveBeenCalledTimes(1); // only the first went out
    await q.flush({ channelId: "c1", reason: "repeat", key: "notifsup:c1:repeat:deploy_failed:app1", teamId: "t1", windowSec: 600 });
    expect(mockSend).toHaveBeenCalledTimes(2);
    const summary = JSON.parse(mockSend.mock.calls[1][1]);
    expect(summary.title).toBe("Deploy failed — blog — 5 more");
    expect(summary.summary).toBe("Happened 5 more times in the last 10 min.");
  });

  it("the channel's own window wins over the hub default, and 0 turns it off", async () => {
    const hubDefault = { get: (k: string) => (k === "NOTIFY_DEDUPE_WINDOW_SEC" ? 600 : "https://web.test") } as unknown as ConfigService;
    const off = prismaMock({ policy: { dedupeWindowSec: 0 } });
    const q = make(off, fakeRedis().svc, hubDefault);
    await q.enqueue("c1", FAIL);
    await q.enqueue("c1", FAIL);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("two different apps never collapse", async () => {
    const prisma = prismaMock({ policy: { dedupeWindowSec: 600 } });
    const q = make(prisma, fakeRedis().svc);
    await q.enqueue("c1", FAIL);
    await q.enqueue("c1", { ...FAIL, ctx: { appName: "shop", appId: "app2" } });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe("per-service rate limit", () => {
  it("passes up to the limit, then combines the rest into one summary", async () => {
    const prisma = prismaMock({ policy: { rateLimitPerMin: 2 } });
    const r = fakeRedis();
    const q = make(prisma, r.svc);
    for (let i = 0; i < 5; i++) await q.enqueue("c1", { ...OK, ctx: { appName: `app${i}`, appId: `a${i}` } });
    expect(mockSend).toHaveBeenCalledTimes(2);
    const key = [...r.ledgers.keys()][0];
    expect(key).toMatch(/^notifsup:c1:rate:/);
    await q.flush({ channelId: "c1", reason: "rate", key, teamId: "t1", windowSec: 60 });
    const summary = JSON.parse(mockSend.mock.calls[2][1]);
    expect(summary.title).toBe("Alerts combined");
    expect(summary.summary).toMatch(/^3 alerts came in faster/);
  });

  it("uses the service default when the channel sets none (SMS is the strictest)", async () => {
    const prisma = prismaMock({ type: "sms", configEnc: `enc(${JSON.stringify({ accountSid: "AC", authToken: "t", from: "+15551230000", to: "+15559870000" })})` });
    const q = make(prisma, fakeRedis().svc);
    for (let i = 0; i < 8; i++) await q.enqueue("c1", { ...FAIL, ctx: { appName: `app${i}`, appId: `a${i}` } });
    expect(mockSend).toHaveBeenCalledTimes(6);
  });

  it("the test button, digests and summaries are never limited", async () => {
    const prisma = prismaMock({ policy: { rateLimitPerMin: 1 } });
    const q = make(prisma, fakeRedis().svc);
    await q.enqueue("c1", OK, { bypassPolicy: true });
    await q.enqueue("c1", OK, { bypassPolicy: true });
    await q.deliverNow("c1", { type: "test", teamId: "t1", ctx: {} });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });
});

describe("fail-open", () => {
  it("a Redis outage never drops an alert", async () => {
    const broken = {
      firstInWindow: jest.fn().mockRejectedValue(new Error("down")),
      incr: jest.fn().mockRejectedValue(new Error("down")),
      ledgerAdd: jest.fn().mockRejectedValue(new Error("down")),
    } as unknown as RedisService;
    const prisma = prismaMock({ policy: { dedupeWindowSec: 600, quietHours: { from: "00:00", to: "23:59", tz: "UTC", allowCritical: true } } });
    await make(prisma, broken).enqueue("c1", FAIL);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("a malformed stored policy is ignored", async () => {
    const prisma = prismaMock({ policy: { quietHours: "nope", rateLimitPerMin: "lots" } });
    await make(prisma, fakeRedis().svc).enqueue("c1", OK);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe("caller-supplied channel", () => {
  it("skips the channel lookup for the policy check", async () => {
    const prisma = prismaMock({});
    await make(prisma, fakeRedis().svc).enqueue("c1", OK, { channel: { type: "webhook", policy: null } });
    // one findUnique: the send path re-reads the channel; none for the policy
    expect((prisma.notificationChannel.findUnique as jest.Mock).mock.calls).toHaveLength(1);
  });
});
