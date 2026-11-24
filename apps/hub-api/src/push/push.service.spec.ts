jest.mock("node:dns/promises");
jest.mock("../notifications/safe-url", () => ({ ...jest.requireActual("../notifications/safe-url"), safeSend: jest.fn() }));

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createECDH } from "node:crypto";
import { lookup } from "node:dns/promises";
import { PushService, MAX_DEVICES_PER_USER, sameOrigin } from "./push.service";
import { HttpStatusError, safeSend } from "../notifications/safe-url";
import { b64u, generateVapidKeys } from "./webpush";
import type { RenderedMessage } from "../notifications/rendered-message";

const mockSend = safeSend as jest.Mock;
const mockLookup = lookup as unknown as jest.Mock;

const crypto = { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, "") };
const config = { get: (k: string) => (k === "WEB_PUBLIC_URL" ? "https://panel.example.com" : undefined) } as unknown as ConfigService;

function browser() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 3)) };
}

function make(prisma: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  const settingsSvc = { get: jest.fn().mockResolvedValue({ acmeEmail: null, vapidPublicKey: null, vapidPrivateKeyEnc: null, ...settings }) };
  return new PushService(prisma as never, crypto as never, settingsSvc as never, config);
}

const msg = (over: Partial<RenderedMessage> = {}): RenderedMessage => ({
  level: "failure",
  title: "Server offline",
  summary: "web-1 stopped responding",
  fields: [],
  links: [{ label: "Open", url: "https://panel.example.com/servers/s1" }],
  timestamp: new Date().toISOString(),
  event: "server_offline",
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockResolvedValue([{ address: "203.0.113.9", family: 4 }]);
  mockSend.mockResolvedValue(undefined);
});

describe("PushService.vapidKeys", () => {
  it("generates once, stores the private half encrypted, and re-reads the winner on a race", async () => {
    const keys = generateVapidKeys();
    const get = jest
      .fn()
      .mockResolvedValueOnce({ vapidPublicKey: null, vapidPrivateKeyEnc: null })
      .mockResolvedValueOnce({ vapidPublicKey: keys.publicKey, vapidPrivateKeyEnc: `enc(${keys.privateKeyPem})` });
    const updateMany = jest.fn().mockResolvedValue({ count: 0 }); // lost the race
    const svc = new PushService({ instanceSettings: { updateMany } } as never, crypto as never, { get } as never, config);
    const got = await svc.vapidKeys();
    expect(got.publicKey).toBe(keys.publicKey);
    const data = updateMany.mock.calls[0][0].data;
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "singleton", vapidPrivateKeyEnc: null });
    expect(data.vapidPrivateKeyEnc).toMatch(/^enc\(-----BEGIN PRIVATE KEY/);
  });

  it("returns the stored pair without writing", async () => {
    const keys = generateVapidKeys();
    const updateMany = jest.fn();
    const svc = new PushService({ instanceSettings: { updateMany } } as never, crypto as never, {
      get: jest.fn().mockResolvedValue({ vapidPublicKey: keys.publicKey, vapidPrivateKeyEnc: `enc(${keys.privateKeyPem})` }),
    } as never, config);
    await expect(svc.publicKey()).resolves.toBe(keys.publicKey);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("PushService.subscribe", () => {
  const row = { id: "d1", deviceLabel: "Phone", endpoint: "https://push.example.com/x", createdAt: new Date(), lastUsedAt: null };

  it("stores the auth secret encrypted and upserts by endpoint", async () => {
    const b = browser();
    const upsert = jest.fn().mockResolvedValue(row);
    const svc = make({ pushSubscription: { upsert, findMany: jest.fn().mockResolvedValue([{ id: "d1" }]), deleteMany: jest.fn() } });
    const v = await svc.subscribe("u1", { endpoint: row.endpoint, keys: b, deviceLabel: "Phone" });
    expect(upsert.mock.calls[0][0].where).toEqual({ endpoint: row.endpoint });
    expect(upsert.mock.calls[0][0].create.authEnc).toBe(`enc(${b.auth})`);
    expect(JSON.stringify(v)).not.toContain("push.example.com/x"); // the capability URL is never echoed back
    expect(v.service).toBe("push.example.com");
  });

  it("rejects plain http, loopback/metadata hosts, and malformed keys", async () => {
    const svc = make({ pushSubscription: { upsert: jest.fn() } });
    const keys = browser();
    await expect(svc.subscribe("u1", { endpoint: "http://push.example.com/x", keys })).rejects.toBeInstanceOf(BadRequestException);
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(svc.subscribe("u1", { endpoint: "https://evil.example.com/x", keys })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.subscribe("u1", { endpoint: "https://127.0.0.1/x", keys })).rejects.toBeInstanceOf(BadRequestException);
    mockLookup.mockResolvedValue([{ address: "203.0.113.9", family: 4 }]);
    await expect(svc.subscribe("u1", { endpoint: "https://push.example.com/x", keys: { p256dh: "AAAA", auth: keys.auth } })).rejects.toThrow(/invalid push subscription keys/);
  });

  it("drops the oldest devices beyond the per-user cap", async () => {
    const ids = Array.from({ length: MAX_DEVICES_PER_USER + 2 }, (_, i) => ({ id: `d${i}` }));
    const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
    const svc = make({ pushSubscription: { upsert: jest.fn().mockResolvedValue(row), findMany: jest.fn().mockResolvedValue(ids), deleteMany } });
    await svc.subscribe("u1", { endpoint: row.endpoint, keys: browser() });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: [`d${MAX_DEVICES_PER_USER}`, `d${MAX_DEVICES_PER_USER + 1}`] } } });
  });

  it("only removes the caller's own device", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const svc = make({ pushSubscription: { deleteMany } });
    await expect(svc.unsubscribe("u1", "d9")).rejects.toBeInstanceOf(NotFoundException);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "d9", userId: "u1" } });
  });
});

describe("PushService.sendToUser", () => {
  const keys = generateVapidKeys();
  const settings = { vapidPublicKey: keys.publicKey, vapidPrivateKeyEnc: `enc(${keys.privateKeyPem})` };
  const payload = { title: "t", body: "b", url: "/", tag: "x", level: "info" };

  function sub(id: string) {
    const b = browser();
    return { id, userId: "u1", endpoint: `https://push.example.com/${id}`, p256dh: b.p256dh, authEnc: `enc(${b.auth})` };
  }

  it("sends an encrypted, VAPID-signed request per device and prunes 404/410 subscriptions", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const svc = make({ pushSubscription: { findMany: jest.fn().mockResolvedValue([sub("a"), sub("b"), sub("c")]), deleteMany, updateMany } }, settings);
    mockSend.mockImplementation(async (url: string) => {
      if (url.endsWith("/b")) throw new HttpStatusError(410);
      if (url.endsWith("/c")) throw new HttpStatusError(503);
    });
    const r = await svc.sendToUser("u1", payload);
    expect(r).toEqual({ sent: 1, removed: 1, failed: 1 });
    const [url, body, headers, opts] = mockSend.mock.calls[0];
    expect(url).toBe("https://push.example.com/a");
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(opts).toEqual({ allowPrivate: false });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["b"] } } });
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["a"] } });
  });

  it("test() reports a conflict when the user has no device", async () => {
    const svc = make({ pushSubscription: { findMany: jest.fn().mockResolvedValue([]) } }, settings);
    await expect(svc.test("u1", payload)).rejects.toBeInstanceOf(ConflictException);
  });

  it("shortens an oversized summary instead of failing the alert", async () => {
    const svc = make({ pushSubscription: { findMany: jest.fn().mockResolvedValue([sub("a")]), updateMany: jest.fn().mockResolvedValue({}) } }, settings);
    await svc.sendToUser("u1", { ...payload, body: "x".repeat(6000) });
    expect(mockSend.mock.calls[0][1].length).toBeLessThanOrEqual(4096);
  });
});

describe("PushService.deliverChannel", () => {
  const keys = generateVapidKeys();
  const settings = { vapidPublicKey: keys.publicKey, vapidPrivateKeyEnc: `enc(${keys.privateKeyPem})` };

  it("refuses when the recipient has left the team", async () => {
    const svc = make({ membership: { findFirst: jest.fn().mockResolvedValue(null) }, pushSubscription: { findMany: jest.fn() } }, settings);
    await expect(svc.deliverChannel({ userId: "u1", teamId: "t1" }, msg())).rejects.toThrow(/no longer a member/);
  });

  it("refuses a channel without a hub-written recipient", async () => {
    const svc = make({}, settings);
    await expect(svc.deliverChannel({}, msg())).rejects.toThrow(/no recipient/);
  });

  it("fails visibly when no device is registered, so the delivery log says why", async () => {
    const svc = make({ membership: { findFirst: jest.fn().mockResolvedValue({ id: "m" }) }, pushSubscription: { findMany: jest.fn().mockResolvedValue([]) } }, settings);
    await expect(svc.deliverChannel({ userId: "u1", teamId: "t1" }, msg())).rejects.toThrow(/no devices registered/);
  });

  it("delivers a failure at high urgency with the panel deep link", async () => {
    const b = browser();
    const svc = make(
      {
        membership: { findFirst: jest.fn().mockResolvedValue({ id: "m" }) },
        pushSubscription: {
          findMany: jest.fn().mockResolvedValue([{ id: "a", endpoint: "https://push.example.com/a", p256dh: b.p256dh, authEnc: `enc(${b.auth})` }]),
          updateMany: jest.fn().mockResolvedValue({}),
        },
      },
      settings,
    );
    await svc.deliverChannel({ userId: "u1", teamId: "t1" }, msg());
    expect(mockSend.mock.calls[0][2].urgency).toBe("high");
  });
});

describe("sameOrigin", () => {
  it("rejects lookalike hosts and bad input, accepts the panel origin", () => {
    expect(sameOrigin("https://panel.example.com/servers/s1", "https://panel.example.com")).toBe(true);
    expect(sameOrigin("https://panel.example.com.evil.test/x", "https://panel.example.com")).toBe(false);
    expect(sameOrigin("not a url", "https://panel.example.com")).toBe(false);
  });
});
