jest.mock("node:dns/promises");
// Keep the SSRF validators REAL (they exercise the policy against mocked DNS); only stub the transport.
jest.mock("./safe-url", () => ({ ...jest.requireActual("./safe-url"), safeSend: jest.fn() }));

import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lookup } from "node:dns/promises";
import { NotificationsService } from "./notifications.service";
import { NotificationQueueService } from "./queue.service";
import { NotifI18nService } from "./notif-i18n.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { RedisService } from "../redis/redis.service";
import { safeSend } from "./safe-url";

const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
// reversible stub crypto: enc(<plain>)
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
} as unknown as CryptoService;
const makeConfig = (allowPrivate: boolean) =>
  ({
    get: (k: string) => (k === "NOTIFY_ALLOW_PRIVATE_TARGETS" ? (allowPrivate ? "true" : "false") : "https://web.test"),
  }) as unknown as ConfigService;

const mockLookup = lookup as unknown as jest.Mock;
const mockSend = safeSend as jest.Mock;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>, allowPrivate = false) {
  const config = makeConfig(allowPrivate);
  // Real queue service — jest sets NODE_ENV=test and onApplicationBootstrap is never called here, so
  // its BullMQ queue stays undefined and delivery runs inline (send via the mocked safeSend).
  // Redis stub — config has no NOTIFY_DEDUPE_WINDOW_SEC (→ NaN → dedupe disabled), so it's never consulted.
  const redis = { firstInWindow: jest.fn().mockResolvedValue(true) } as unknown as RedisService;
  const queue = new NotificationQueueService(prisma as PrismaService, crypto, audit, config, new NotifI18nService(), redis, {} as never);
  return new NotificationsService(prisma as PrismaService, access as TeamAccessService, audit, crypto, config, queue);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockResolvedValue([{ address: "203.0.113.7", family: 4 }]); // resolve public by default
  mockSend.mockResolvedValue(undefined);
});

describe("NotificationsService push channels", () => {
  const row = { id: "c1", name: "Phone", type: "push", teamId: "t1", enabled: true, eventTypes: [], categories: ["server"] };

  it("pins the recipient to the creator, ignoring any config the client sent", async () => {
    const create = jest.fn().mockResolvedValue(row);
    const svc = make({ notificationChannel: { create } } as unknown as PrismaService, { requirePermission: jest.fn().mockResolvedValue(undefined) });
    await svc.create("u1", { name: "Phone", type: "push", teamId: "t1", config: { userId: "victim", teamId: "other" }, categories: ["server"] });
    expect(create.mock.calls[0][0].data.configEnc).toBe(`enc(${JSON.stringify({ userId: "u1", teamId: "t1" })})`);
  });

  it("never lets an update retarget the recipient", async () => {
    const update = jest.fn().mockResolvedValue(row);
    const svc = make(
      { notificationChannel: { findUnique: jest.fn().mockResolvedValue({ ...row, configEnc: "enc({})" }), update } } as unknown as PrismaService,
      { requirePermission: jest.fn().mockResolvedValue(undefined) },
    );
    await svc.update("u2", "c1", { config: { userId: "u2" }, minSeverity: "critical" });
    const data = update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("configEnc");
    expect(data.minSeverity).toBe("critical");
  });

  it("lets only the recipient fire a push channel's test", async () => {
    const find = jest.fn().mockResolvedValue({ ...row, locale: "en", configEnc: `enc(${JSON.stringify({ userId: "u1", teamId: "t1" })})` });
    const svc = make({ notificationChannel: { findUnique: find } } as unknown as PrismaService, { teamRole: jest.fn().mockResolvedValue("ADMIN") });
    await expect(svc.test("u2", "c1")).rejects.toThrow(/only the recipient/);
  });

  it("requires the integrations permission like every other channel type", async () => {
    const svc = make({} as unknown as PrismaService, { requirePermission: jest.fn().mockRejectedValue(new Error("forbidden")) });
    await expect(svc.create("u1", { name: "Phone", type: "push", teamId: "t1", config: {} })).rejects.toThrow("forbidden");
  });
});

describe("NotificationsService", () => {
  it("encrypts the config blob on create (never plaintext)", async () => {
    const create = jest.fn().mockResolvedValue({ id: "c1", name: "n", type: "webhook", teamId: "t1", enabled: true, eventTypes: [] });
    const svc = make(
      { notificationChannel: { create } } as unknown as PrismaService,
      { requirePermission: jest.fn().mockResolvedValue(undefined) },
    );
    await svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "https://hook.test" }, eventTypes: ["deploy_failed"] });
    const data = create.mock.calls[0][0].data;
    expect(data.configEnc).toBe(`enc(${JSON.stringify({ url: "https://hook.test" })})`);
    expect(data.eventTypes).toEqual(["deploy_failed"]);
    expect(data).not.toHaveProperty("config");
  });

  it("rejects an unsupported channel type", async () => {
    const svc = make({} as PrismaService, { requirePermission: jest.fn().mockResolvedValue(undefined) });
    await expect(
      svc.create("u1", { name: "n", type: "carrierpigeon", teamId: "t1", config: {} }),
    ).rejects.toThrow(/unsupported/);
  });

  describe("SSRF validation on create/update", () => {
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };

    it("rejects a webhook whose url is a blocked address (cloud metadata) before persisting", async () => {
      const create = jest.fn();
      const svc = make({ notificationChannel: { create } } as unknown as PrismaService, access);
      await expect(
        svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "http://169.254.169.254/latest/meta-data/" } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    });

    it("rejects a webhook whose host resolves to a private address (default policy)", async () => {
      mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
      const create = jest.fn();
      const svc = make({ notificationChannel: { create } } as unknown as PrismaService, access);
      await expect(
        svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "http://internal.example" } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    });

    it("allows a private target when NOTIFY_ALLOW_PRIVATE_TARGETS is set", async () => {
      const create = jest.fn().mockResolvedValue({ id: "c1", name: "n", type: "webhook", teamId: "t1", enabled: true, eventTypes: [] });
      const svc = make({ notificationChannel: { create } } as unknown as PrismaService, access, true);
      await expect(
        svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "http://192.168.1.10/hook" } }),
      ).resolves.toBeDefined();
      expect(create).toHaveBeenCalled();
    });

    it("rejects a webhook with a too-short signing secret (shape check)", async () => {
      const create = jest.fn();
      const svc = make({ notificationChannel: { create } } as unknown as PrismaService, access);
      await expect(
        svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "https://hook.test", signingSecret: "short" } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    });

    it("re-validates the url on update against the stored channel type", async () => {
      const existing = { id: "c1", teamId: "t1", name: "n", type: "webhook", enabled: true, eventTypes: [], configEnc: "enc({})" };
      const update = jest.fn();
      const svc = make(
        { notificationChannel: { findUnique: jest.fn().mockResolvedValue(existing), update } } as unknown as PrismaService,
        access,
      );
      await expect(svc.update("u1", "c1", { config: { url: "http://127.0.0.1/hook" } })).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });
  });

  it("fireForEvent only queries enabled channels subscribed to the event", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = make({ notificationChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForEvent("t1", "deploy_failed", { appName: "blog" });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        teamId: "t1",
        enabled: true,
        OR: [{ eventTypes: { has: "deploy_failed" } }, { categories: { has: "deploy" } }],
      },
    });
  });

  it("fireForEvent early-outs without rendering when no channels match", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = make({ notificationChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForEvent("t1", "deploy_failed", { appName: "blog" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // The inline (test-mode) delivery path re-fetches the channel and records a NotificationDelivery.
  const webhookChannel = { id: "c1", teamId: "t1", type: "webhook", eventTypes: ["deploy_failed"], configEnc: `enc(${JSON.stringify({ url: "https://hook" })})` };
  const deliveryStub = () => ({
    create: jest.fn().mockResolvedValue({ id: "d1" }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  });

  it("fireForEvent dispatches to matching channels and swallows provider errors", async () => {
    mockSend.mockRejectedValue(new Error("HTTP 500"));
    const svc = make(
      {
        notificationChannel: { findMany: jest.fn().mockResolvedValue([webhookChannel]), findUnique: jest.fn().mockResolvedValue(webhookChannel) },
        notificationDelivery: deliveryStub(),
      } as unknown as PrismaService,
      {},
    );
    await expect(svc.fireForEvent("t1", "deploy_failed", { appName: "blog" })).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledWith("https://hook", expect.any(String), expect.any(Object), expect.any(Object));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "notification.failed", target: "c1" }));
  });

  it("fireForEvent isolates a per-channel enqueue failure — the remaining channels still fire", async () => {
    const chA = { id: "cA", teamId: "t1", type: "webhook", eventTypes: ["deploy_failed"], configEnc: `enc(${JSON.stringify({ url: "https://a" })})` };
    const chB = { id: "cB", teamId: "t1", type: "webhook", eventTypes: ["deploy_failed"], configEnc: `enc(${JSON.stringify({ url: "https://b" })})` };
    // cA's snapshot create fails (e.g. the channel was just deleted → FK violation); cB must still send.
    const create = jest.fn().mockRejectedValueOnce(new Error("P2003")).mockResolvedValue({ id: "d2" });
    const svc = make(
      {
        notificationChannel: { findMany: jest.fn().mockResolvedValue([chA, chB]), findUnique: jest.fn().mockResolvedValue(chB) },
        notificationDelivery: { create, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      } as unknown as PrismaService,
      {},
    );
    await expect(svc.fireForEvent("t1", "deploy_failed", { appName: "blog" })).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(1); // cA skipped (create failed), cB delivered
    expect(mockSend).toHaveBeenCalledWith("https://b", expect.any(String), expect.any(Object), expect.any(Object));
  });

  it("fireForEvent renders the typed template into a structured body (level/title/fields/link)", async () => {
    const svc = make(
      {
        notificationChannel: { findMany: jest.fn().mockResolvedValue([webhookChannel]), findUnique: jest.fn().mockResolvedValue(webhookChannel) },
        notificationDelivery: deliveryStub(),
      } as unknown as PrismaService,
      {},
    );
    await svc.fireForEvent("t1", "deploy_failed", { appName: "blog", appId: "app1", projectName: "web" });
    const body = JSON.parse(mockSend.mock.calls[0][1]);
    expect(body.event).toBe("deploy_failed");
    expect(body.level).toBe("failure");
    expect(body.title).toBe("Deploy failed — blog");
    expect(body.fields.find((f: { label: string }) => f.label === "Project").value).toBe("web");
    expect(body.links.find((l: { label: string }) => l.label === "View in Tugra").url).toBe("https://web.test/apps/app1");
  });

  it("fireForMonitor derives monitor_up/down from ctx.status and hits only enabled links", async () => {
    const svc = make(
      {
        monitorChannel: {
          findMany: jest.fn().mockResolvedValue([
            { channelId: "c1", channel: { enabled: true, type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://hook" })})` } },
            { channelId: "c2", channel: { enabled: false, type: "webhook", configEnc: "enc({})" } },
          ]),
        },
        notificationChannel: { findUnique: jest.fn().mockResolvedValue(webhookChannel) },
        notificationDelivery: deliveryStub(),
      } as unknown as PrismaService,
      {},
    );
    await svc.fireForMonitor("m1", { status: "DOWN", monitorName: "api", target: "x", teamId: "t1" });
    expect(mockSend).toHaveBeenCalledTimes(1); // disabled link skipped
    const body = JSON.parse(mockSend.mock.calls[0][1]);
    expect(body.event).toBe("monitor_down");
    expect(body.level).toBe("failure");
  });

  it("fireForMonitor early-outs when no linked channel is enabled", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { channelId: "c1", channel: { enabled: false, type: "webhook", configEnc: "enc({})" } },
    ]);
    const svc = make({ monitorChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForMonitor("m1", { status: "UP" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("update can change eventTypes without re-encrypting when no config given", async () => {
    const existing = { id: "c1", teamId: "t1", name: "n", type: "webhook", enabled: true, eventTypes: [], configEnc: "enc({})" };
    const update = jest.fn().mockResolvedValue({ ...existing, eventTypes: ["server_offline"] });
    const svc = make(
      { notificationChannel: { findUnique: jest.fn().mockResolvedValue(existing), update } } as unknown as PrismaService,
      { requirePermission: jest.fn().mockResolvedValue(undefined) },
    );
    const v = await svc.update("u1", "c1", { eventTypes: ["server_offline"] });
    expect(v.eventTypes).toEqual(["server_offline"]);
    expect(update.mock.calls[0][0].data).not.toHaveProperty("configEnc");
  });

  it("list() sets canWrite per the caller's role in each channel's team", async () => {
    const prisma = {
      notificationChannel: {
        findMany: jest.fn().mockResolvedValue([
          { id: "c1", name: "a", type: "slack", teamId: "tOwner", enabled: true, eventTypes: [] },
          { id: "c2", name: "b", type: "slack", teamId: "tViewer", enabled: true, eventTypes: [] },
        ]),
      },
    } as unknown as PrismaService;
    const allPerms = new Set([
      "apps:deploy", "apps:config", "databases", "backups", "servers:manage",
      "servers:ops", "terminal", "bulk", "monitors", "projects", "integrations", "variables",
    ]);
    const access = {
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["tOwner", allPerms], ["tViewer", new Set()]])),
    } as unknown as TeamAccessService;
    const list = await make(prisma, access).list("u1");
    expect(list.find((c) => c.id === "c1")!.canWrite).toBe(true);
    expect(list.find((c) => c.id === "c2")!.canWrite).toBe(false);
  });

  describe("routing rule", () => {
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
    const row = (over: Record<string, unknown> = {}) => ({
      id: "c1", teamId: "t1", type: "webhook", enabled: true, eventTypes: [], categories: [], minSeverity: "info",
      configEnc: `enc(${JSON.stringify({ url: "https://hook" })})`, ...over,
    });
    const svcFor = (channels: unknown[], extra: Record<string, unknown> = {}) =>
      make(
        {
          notificationChannel: { findMany: jest.fn().mockResolvedValue(channels), findUnique: jest.fn().mockImplementation(({ where }) => channels.find((c) => (c as { id: string }).id === where.id)), ...extra },
          notificationDelivery: deliveryStub(),
        } as unknown as PrismaService,
        access,
      );

    it("create stores categories / minSeverity / topics; defaults keep legacy behaviour", async () => {
      const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "c1", teamId: "t1", enabled: true, ...data }));
      const svc = make({ notificationChannel: { create } } as unknown as PrismaService, access);
      const v = await svc.create("u1", {
        name: "n", type: "telegram", teamId: "t1", config: { botToken: "x", chatId: "-1" },
        categories: ["deploy"], minSeverity: "warning", topics: { deploy: 7 },
      });
      expect(create.mock.calls[0][0].data).toMatchObject({ categories: ["deploy"], minSeverity: "warning", topics: { deploy: 7 } });
      expect(v).toMatchObject({ categories: ["deploy"], minSeverity: "warning", topics: { deploy: 7 } });

      await svc.create("u1", { name: "n", type: "telegram", teamId: "t1", config: { botToken: "x", chatId: "-1" } });
      expect(create.mock.calls[1][0].data).toMatchObject({ categories: [], minSeverity: "info" });
      expect(create.mock.calls[1][0].data).not.toHaveProperty("topics");
    });

    it("refuses a topic map on a non-telegram channel (create and update)", async () => {
      const create = jest.fn();
      const svc = make({ notificationChannel: { create, findUnique: jest.fn().mockResolvedValue(row()) } } as unknown as PrismaService, access);
      await expect(
        svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "https://hook.test" }, topics: { deploy: 1 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.update("u1", "c1", { topics: { deploy: 1 } })).rejects.toBeInstanceOf(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    });

    it("update replaces rule fields, clears topics with null, and leaves them alone when omitted", async () => {
      const existing = row({ type: "telegram", topics: { deploy: 3 } });
      const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...existing, ...data }));
      const svc = make({ notificationChannel: { findUnique: jest.fn().mockResolvedValue(existing), update } } as unknown as PrismaService, access);
      await svc.update("u1", "c1", { categories: ["backup"], minSeverity: "critical" });
      expect(update.mock.calls[0][0].data).toMatchObject({ categories: ["backup"], minSeverity: "critical" });
      expect(update.mock.calls[0][0].data).not.toHaveProperty("topics");
      await svc.update("u1", "c1", { topics: null });
      expect(update.mock.calls[1][0].data.topics).toBeDefined(); // Prisma.DbNull sentinel
      await svc.update("u1", "c1", { topics: { backup: 4 } });
      expect(update.mock.calls[2][0].data.topics).toEqual({ backup: 4 });
    });

    it("fireForEvent delivers by category and honours the severity floor", async () => {
      const byCat = row({ id: "cCat", categories: ["deploy"], minSeverity: "critical" });
      const svc = svcFor([byCat]);
      await svc.fireForEvent("t1", "deploy_success", { appName: "blog" }); // info < critical → dropped
      expect(mockSend).not.toHaveBeenCalled();
      await svc.fireForEvent("t1", "deploy_failed", { appName: "blog" }); // critical → sent
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("fireForMonitor: a channel whose categories exclude uptime is skipped; legacy passes", async () => {
      const mk = (id: string, over: Record<string, unknown>) => ({ channelId: id, channel: row({ id, ...over }) });
      const svc = svcFor([row({ id: "cLegacy" })], {});
      (svc as unknown as { prisma: { monitorChannel: unknown } }).prisma.monitorChannel = {
        findMany: jest.fn().mockResolvedValue([
          mk("cLegacy", {}),
          mk("cDeployOnly", { categories: ["deploy"] }),
          mk("cUptime", { categories: ["uptime"] }),
          mk("cDownOnly", { categories: ["uptime"], minSeverity: "critical" }),
        ]),
      };
      const sent: string[] = [];
      const q = (svc as unknown as { queue: { enqueue: jest.Mock } }).queue;
      jest.spyOn(q, "enqueue").mockImplementation(async (id: string) => { sent.push(id); });
      await svc.fireForMonitor("m1", { status: "UP", teamId: "t1" });
      expect(sent).toEqual(["cLegacy", "cUptime"]); // recovery (info) dropped for cDownOnly
      sent.length = 0;
      await svc.fireForMonitor("m1", { status: "DOWN", teamId: "t1" });
      expect(sent).toEqual(["cLegacy", "cUptime", "cDownOnly"]);
    });

    it("test(category) sends a test naming the category and routes it to that category's topic", async () => {
      const tg = row({ id: "cTg", type: "telegram", topics: { backup: 55 }, configEnc: `enc(${JSON.stringify({ botToken: "tok", chatId: "-1", messageThreadId: 2 })})`, locale: "en" });
      const svc = make(
        {
          notificationChannel: { findUnique: jest.fn().mockResolvedValue(tg) },
          notificationDelivery: deliveryStub(),
        } as unknown as PrismaService,
        { teamRole: jest.fn().mockResolvedValue("OWNER") },
      );
      await svc.test("u1", "cTg", "backup");
      const [url, rawBody] = mockSend.mock.calls[0];
      const body = JSON.parse(rawBody);
      expect(url).toContain("/bottok/sendMessage");
      expect(body.message_thread_id).toBe(55);
      expect(body.text).toContain("Category: Backup");

      mockSend.mockClear();
      await svc.test("u1", "cTg", "deploy"); // unmapped category → channel default topic
      expect(JSON.parse(mockSend.mock.calls[0][1]).message_thread_id).toBe(2);
      mockSend.mockClear();
      await svc.test("u1", "cTg"); // no category → plain test, default topic, no category line
      const plain = JSON.parse(mockSend.mock.calls[0][1]);
      expect(plain.message_thread_id).toBe(2);
      expect(plain.text).not.toContain("Category:");
    });

    it("a real event reaches the telegram topic of its category", async () => {
      const tg = row({ id: "cTg", type: "telegram", categories: ["backup", "deploy"], topics: { backup: 55 }, configEnc: `enc(${JSON.stringify({ botToken: "tok", chatId: "-1" })})` });
      const svc = svcFor([tg]);
      await svc.fireForEvent("t1", "backup_failed", { dbName: "main" });
      expect(JSON.parse(mockSend.mock.calls[0][1]).message_thread_id).toBe(55);
      mockSend.mockClear();
      await svc.fireForEvent("t1", "deploy_failed", { appName: "blog" }); // no deploy topic → no thread
      expect(JSON.parse(mockSend.mock.calls[0][1]).message_thread_id).toBeUndefined();
    });
  });
});

describe("NotificationsService — new channel types, URL creation and policy", () => {
  const okAccess = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const createRow = (data: Record<string, unknown>) => ({ id: "cNew", enabled: true, eventTypes: [], categories: [], minSeverity: "info", ...data });

  function svcWithCreate() {
    const create = jest.fn().mockImplementation(({ data }) => Promise.resolve(createRow(data)));
    const svc = make({ notificationChannel: { create } } as unknown as PrismaService, okAccess);
    return { svc, create };
  }

  it("validates required fields for the new types", async () => {
    const { svc } = svcWithCreate();
    await expect(svc.create("u1", { name: "m", type: "matrix", teamId: "t1", config: { homeserver: "https://m.example.com", roomId: "!a:example.com" } })).rejects.toThrow(/access token/);
    await expect(svc.create("u1", { name: "s", type: "sms", teamId: "t1", config: { accountSid: "nope", authToken: "x", from: "+1555123", to: "+1555987" } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create("u1", { name: "g", type: "googlechat", teamId: "t1", config: { webhookUrl: "https://evil.example.com/hook" } })).rejects.toThrow(/chat\.googleapis\.com/);
  });

  it("SSRF-guards the user-supplied host of the new types", async () => {
    const { svc } = svcWithCreate();
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(svc.create("u1", { name: "z", type: "zulip", teamId: "t1", config: { server: "https://zulip.example.com", email: "b@e.com", apiKey: "k", stream: "ops" } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create("u1", { name: "sig", type: "signal", teamId: "t1", config: { server: "http://127.0.0.1:8080", number: "+15551230000", recipients: "+15559870000" } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("stores a policy only when it carries a real setting", async () => {
    const { svc, create } = svcWithCreate();
    await svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "https://hook.test" }, policy: { quietHours: null, rateLimitPerMin: null } });
    expect(create.mock.calls[0][0].data).not.toHaveProperty("policy");
    await svc.create("u1", {
      name: "n",
      type: "webhook",
      teamId: "t1",
      config: { url: "https://hook.test" },
      policy: { quietHours: { from: "22:00", to: "07:00", tz: "UTC", allowCritical: true }, rateLimitPerMin: 10 },
    });
    expect(create.mock.calls[1][0].data.policy).toEqual({ quietHours: { from: "22:00", to: "07:00", tz: "UTC", allowCritical: true }, rateLimitPerMin: 10 });
  });

  it("creates a channel from a Shoutrrr/Apprise URL, encrypted, without leaking the URL", async () => {
    const { svc, create } = svcWithCreate();
    const tok = "123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123";
    const view = await svc.createFromUrl("u1", { teamId: "t1", url: `tgram://${tok}@telegram?chats=@alerts`, categories: ["deploy"] });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "Telegram", type: "telegram", teamId: "t1", categories: ["deploy"] });
    expect(JSON.parse(data.configEnc.replace(/^enc\(/, "").replace(/\)$/, ""))).toEqual({ botToken: tok, chatId: "@alerts" });
    expect(JSON.stringify(view)).not.toContain(tok);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.create" }));
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain(tok);
  });

  it("a bad URL is a 400 that never repeats the URL", async () => {
    const { svc } = svcWithCreate();
    await expect(svc.createFromUrl("u1", { teamId: "t1", url: "tgram://hunter2-secret/abc" })).rejects.toThrow(BadRequestException);
    try {
      await svc.createFromUrl("u1", { teamId: "t1", url: "tgram://hunter2-secret/abc" });
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });

  it("a URL pointing at a private address is refused like any other channel", async () => {
    const { svc } = svcWithCreate();
    await expect(svc.createFromUrl("u1", { teamId: "t1", url: "ntfy://ntfy.example.com/alerts" })).resolves.toBeTruthy();
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(svc.createFromUrl("u1", { teamId: "t1", url: "ntfy://ntfy.example.com/alerts" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("requires the integrations permission, for the preview too", async () => {
    const deny = { requirePermission: jest.fn().mockRejectedValue(new Error("forbidden")) };
    const svc = make({} as unknown as PrismaService, deny);
    await expect(svc.createFromUrl("u1", { teamId: "t1", url: "ntfy://alerts" })).rejects.toThrow("forbidden");
    await expect(svc.previewUrl("u1", { teamId: "t1", url: "ntfy://alerts" })).rejects.toThrow("forbidden");
  });

  it("previewUrl masks credentials", async () => {
    const svc = make({} as unknown as PrismaService, okAccess);
    const out = await svc.previewUrl("u1", { teamId: "t1", url: "discord://abcDEF_ghi-1234567890@123456789012345678" });
    expect(out).toEqual({ type: "discord", suggestedName: "Discord", config: { webhookUrl: "https://discord.com" } });
  });

  it("update: null clears the policy, undefined keeps it", async () => {
    const existing = { id: "c1", teamId: "t1", type: "webhook", name: "n", enabled: true, eventTypes: [], categories: [], minSeverity: "info", locale: "en" };
    const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...existing, ...data }));
    const svc = make({ notificationChannel: { findUnique: jest.fn().mockResolvedValue(existing), update } } as unknown as PrismaService, okAccess);
    await svc.update("u1", "c1", { name: "x" });
    expect(update.mock.calls[0][0].data).not.toHaveProperty("policy");
    await svc.update("u1", "c1", { policy: null });
    expect(update.mock.calls[1][0].data).toHaveProperty("policy");
    expect(update.mock.calls[1][0].data.policy).toBeDefined();
  });
});
