// Keep the SSRF validators real; only stub the HTTP transport that providers ultimately call.
jest.mock("./safe-url", () => ({ ...jest.requireActual("./safe-url"), safeSend: jest.fn() }));

import { ConfigService } from "@nestjs/config";
import { NotificationQueueService, sanitizeError } from "./queue.service";
import { NotifI18nService } from "./notif-i18n.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { safeSend } from "./safe-url";
import type { NotificationEvent } from "./event";

const mockSend = safeSend as jest.Mock;
const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
} as unknown as CryptoService;
const config = { get: () => "https://web.test" } as unknown as ConfigService;

const EVENT: NotificationEvent = { type: "deploy_failed", teamId: "t1", ctx: { appName: "blog", appId: "app1" } };
const webhookChannel = { id: "c1", type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://hook" })})` };

function make(prisma: Partial<PrismaService>) {
  return new NotificationQueueService(prisma as PrismaService, crypto, audit, config, new NotifI18nService());
}
// handleFailed is private (the real worker wires it); invoke it directly in the unit test.
const callFailed = (svc: NotificationQueueService, job: unknown, err: Error): Promise<void> =>
  (svc as unknown as { handleFailed(j: unknown, e: Error): Promise<void> }).handleFailed(job, err);
const updateManyOf = (prisma: PrismaService) => prisma.notificationDelivery.updateMany as jest.Mock;
function prismaMock(over: Record<string, unknown> = {}) {
  return {
    notificationDelivery: {
      create: jest.fn().mockResolvedValue({ id: "d1" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    notificationChannel: { findUnique: jest.fn().mockResolvedValue(webhookChannel) },
    ...over,
  } as unknown as PrismaService;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
});

describe("NotificationQueueService — inline (test-mode) delivery", () => {
  it("enqueue snapshots a PENDING delivery then marks SENT on success", async () => {
    const prisma = prismaMock();
    await make(prisma).enqueue("c1", EVENT);
    const create = (prisma.notificationDelivery.create as jest.Mock).mock.calls[0][0];
    expect(create.data).toMatchObject({ channelId: "c1", event: "deploy_failed", level: "failure", title: expect.any(String), summary: expect.any(String) });
    expect(create.data.status).toBeUndefined(); // schema default PENDING
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect((prisma.notificationDelivery.updateMany as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1", status: { not: "SENT" } }, data: expect.objectContaining({ status: "SENT", attempts: 1 }) }),
    );
  });

  it("enqueue swallows a provider failure (marks FAILED + audits, resolves)", async () => {
    mockSend.mockRejectedValue(new Error("webhook: HTTP 500"));
    const prisma = prismaMock();
    await expect(make(prisma).enqueue("c1", EVENT)).resolves.toBeUndefined();
    expect((prisma.notificationDelivery.updateMany as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "notification.failed", target: "c1" }));
  });

  it("deliverNow records FAILED and RETHROWS so the test button surfaces the error", async () => {
    mockSend.mockRejectedValue(new Error("webhook: HTTP 401"));
    const prisma = prismaMock();
    await expect(make(prisma).deliverNow("c1", EVENT)).rejects.toThrow(/401/);
    expect((prisma.notificationDelivery.updateMany as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
    expect(audit.log).not.toHaveBeenCalled(); // deliverNow does not audit (mirrors legacy test())
  });

  it("a cascade-deleted channel makes an attempt a no-op (no send, no throw)", async () => {
    const prisma = prismaMock({ notificationChannel: { findUnique: jest.fn().mockResolvedValue(null) } });
    await expect(make(prisma).enqueue("c1", EVENT)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("enqueue NEVER throws when the delivery-row create fails (best-effort — loop isolation)", async () => {
    const prisma = prismaMock({
      notificationDelivery: { create: jest.fn().mockRejectedValue(new Error("P2003 FK violation")), updateMany: jest.fn() },
    });
    await expect(make(prisma).enqueue("c1", EVENT)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled(); // couldn't even record → skip, don't abort the caller
  });
});

describe("NotificationQueueService — worker failed-handler (retry → DEAD)", () => {
  const failedJob = (attemptsMade: number, attempts = 5) => ({
    data: { deliveryId: "d1", channelId: "c1", event: EVENT },
    attemptsMade,
    opts: { attempts },
  });

  it("interim retry marks FAILED and does NOT audit dead", async () => {
    const prisma = prismaMock();
    await callFailed(make(prisma), failedJob(2), new Error("boom"));
    expect(updateManyOf(prisma)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1", status: { not: "SENT" } }, data: expect.objectContaining({ status: "FAILED", attempts: 2 }) }),
    );
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("the final attempt marks DEAD and audits notification.dead", async () => {
    const prisma = prismaMock();
    await callFailed(make(prisma), failedJob(5), new Error("boom"));
    expect(updateManyOf(prisma)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DEAD", attempts: 5 }) }),
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "notification.dead", target: "c1" }));
  });

  it("DEAD boundary: attemptsMade 4 → FAILED, 5 → DEAD (pins >= attempts)", async () => {
    const p4 = prismaMock();
    await callFailed(make(p4), failedJob(4), new Error("x"));
    expect(updateManyOf(p4)).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    const p5 = prismaMock();
    await callFailed(make(p5), failedJob(5), new Error("x"));
    expect(updateManyOf(p5)).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DEAD" }) }));
  });

  it("handleFailed(undefined) is a no-op", async () => {
    const prisma = prismaMock();
    await callFailed(make(prisma), undefined, new Error("x"));
    expect(updateManyOf(prisma)).not.toHaveBeenCalled();
  });
});

describe("NotificationQueueService — queued (prod) path", () => {
  it("puts ONLY {deliveryId, channelId, event} on the job — never the channel config", async () => {
    const prisma = prismaMock();
    const svc = make(prisma);
    const add = jest.fn().mockResolvedValue(undefined);
    (svc as unknown as { queue: { add: jest.Mock } }).queue = { add };
    await svc.enqueue("c1", EVENT);
    expect(mockSend).not.toHaveBeenCalled(); // queued, not sent inline
    const [name, data, opts] = add.mock.calls[0];
    expect(name).toBe("deliver");
    expect(data).toEqual({ deliveryId: "d1", channelId: "c1", event: EVENT });
    expect(JSON.stringify(data)).not.toContain("configEnc");
    expect(JSON.stringify(data)).not.toContain("enc(");
    expect(JSON.parse(JSON.stringify(data))).toEqual(data); // JSON round-trips cleanly for Redis
    expect(opts).toMatchObject({ attempts: 5, backoff: { type: "exponential", delay: 10_000 }, removeOnComplete: 1000, removeOnFail: { count: 5000 } });
  });

  it("records FAILED (not stuck PENDING) and does not throw when queue.add rejects (Redis down)", async () => {
    const prisma = prismaMock();
    const svc = make(prisma);
    (svc as unknown as { queue: { add: jest.Mock } }).queue = { add: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    await expect(svc.enqueue("c1", EVENT)).resolves.toBeUndefined();
    expect(updateManyOf(prisma)).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });
});

describe("sanitizeError", () => {
  it("redacts credential-looking substrings and clamps to 200 chars", () => {
    const out = sanitizeError(new Error("POST https://api.example/send?token=SUPERSECRET failed with bearer abc123"));
    expect(out).not.toContain("SUPERSECRET");
    expect(out).not.toContain("abc123");
    expect(out).toContain("***");
    expect(sanitizeError(new Error("x".repeat(500))).length).toBeLessThanOrEqual(200);
  });

  it("leaves a benign HTTP status message intact", () => {
    expect(sanitizeError(new Error("webhook: HTTP 500"))).toBe("webhook: HTTP 500");
  });
});
