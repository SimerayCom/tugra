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
  const queue = new NotificationQueueService(prisma as PrismaService, crypto, audit, config, new NotifI18nService());
  return new NotificationsService(prisma as PrismaService, access as TeamAccessService, audit, crypto, config, queue);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockResolvedValue([{ address: "203.0.113.7", family: 4 }]); // resolve public by default
  mockSend.mockResolvedValue(undefined);
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
      where: { teamId: "t1", enabled: true, eventTypes: { has: "deploy_failed" } },
    });
  });

  it("fireForEvent early-outs without rendering when no channels match", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = make({ notificationChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForEvent("t1", "deploy_failed", { appName: "blog" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // The inline (test-mode) delivery path re-fetches the channel and records a NotificationDelivery.
  const webhookChannel = { id: "c1", teamId: "t1", type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://hook" })})` };
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
    const chA = { id: "cA", teamId: "t1", type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://a" })})` };
    const chB = { id: "cB", teamId: "t1", type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://b" })})` };
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
});
