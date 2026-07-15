import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "./notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
// reversible stub crypto: enc(<plain>)
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
} as unknown as CryptoService;
const config = { get: () => "https://web.test" } as unknown as ConfigService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new NotificationsService(prisma as PrismaService, access as TeamAccessService, audit, crypto, config);
}

describe("NotificationsService", () => {
  it("encrypts the config blob on create (never plaintext)", async () => {
    const create = jest.fn().mockResolvedValue({ id: "c1", name: "n", type: "webhook", teamId: "t1", enabled: true, eventTypes: [] });
    const svc = make(
      { notificationChannel: { create } } as unknown as PrismaService,
      { requirePermission: jest.fn().mockResolvedValue(undefined) },
    );
    await svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "https://x" }, eventTypes: ["deploy_failed"] });
    const data = create.mock.calls[0][0].data;
    expect(data.configEnc).toBe(`enc(${JSON.stringify({ url: "https://x" })})`);
    expect(data.eventTypes).toEqual(["deploy_failed"]);
    expect(data).not.toHaveProperty("config");
  });

  it("rejects an unsupported channel type", async () => {
    const svc = make({} as PrismaService, { requirePermission: jest.fn().mockResolvedValue(undefined) });
    await expect(
      svc.create("u1", { name: "n", type: "carrierpigeon", teamId: "t1", config: {} }),
    ).rejects.toThrow(/unsupported/);
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
    const fetchMock = jest.fn();
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const svc = make({ notificationChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForEvent("t1", "deploy_failed", { appName: "blog" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fireForEvent dispatches to matching channels and swallows provider errors", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "c1", type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://hook" })})` },
    ]);
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const svc = make({ notificationChannel: { findMany } } as unknown as PrismaService, {});
    await expect(svc.fireForEvent("t1", "deploy_failed", { appName: "blog" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://hook", expect.objectContaining({ method: "POST" }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "notification.failed", target: "c1" }));
  });

  it("fireForEvent renders the typed template into a structured body (level/title/fields/link)", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "c1", type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://hook" })})` },
    ]);
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const svc = make({ notificationChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForEvent("t1", "deploy_failed", { appName: "blog", appId: "app1", projectName: "web" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.event).toBe("deploy_failed");
    expect(body.level).toBe("failure");
    expect(body.title).toBe("Deploy failed — blog");
    expect(body.fields.find((f: { label: string }) => f.label === "Project").value).toBe("web");
    expect(body.links.find((l: { label: string }) => l.label === "View in Tugra").url).toBe("https://web.test/apps/app1");
  });

  it("fireForMonitor derives monitor_up/down from ctx.status and hits only enabled links", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { channelId: "c1", channel: { enabled: true, type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://hook" })})` } },
      { channelId: "c2", channel: { enabled: false, type: "webhook", configEnc: "enc({})" } },
    ]);
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const svc = make({ monitorChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForMonitor("m1", { status: "DOWN", monitorName: "api", target: "x", teamId: "t1" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // disabled link skipped
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.event).toBe("monitor_down");
    expect(body.level).toBe("failure");
  });

  it("fireForMonitor early-outs when no linked channel is enabled", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { channelId: "c1", channel: { enabled: false, type: "webhook", configEnc: "enc({})" } },
    ]);
    const fetchMock = jest.fn();
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const svc = make({ monitorChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForMonitor("m1", { status: "UP" });
    expect(fetchMock).not.toHaveBeenCalled();
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
