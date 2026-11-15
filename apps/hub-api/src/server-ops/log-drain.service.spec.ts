import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LogDrainService } from "./log-drain.service";
import { CreateLogDrainSchema, UpdateLogDrainSchema } from "./dto";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AuditService } from "../audit/audit.service";
import { LogDrainPushService } from "../log-drains/log-drain-push.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;

function pushStub() {
  return {
    pushToAgent: jest.fn().mockResolvedValue(undefined),
    deliveryFor: jest.fn().mockReturnValue({ delivery: "pending", status: null }),
  };
}

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>, push = pushStub()) {
  const svc = new LogDrainService(prisma as PrismaService, access as TeamAccessService, crypto, {} as AgentWsServer, audit, push as unknown as LogDrainPushService);
  return { svc, push };
}

const server = { id: "s1", teamId: "t1", clusterId: null };
const okAccess = () => ({ requirePermission: jest.fn().mockResolvedValue(undefined) }) as unknown as TeamAccessService;
const row = (over: Record<string, unknown> = {}) => ({
  id: "d1", serverId: "s1", appId: null, name: "n", type: "http", endpoint: "https://x", authTokenEnc: null, enabled: true,
  containers: [], options: null, allowPrivate: false, createdAt: new Date(), ...over,
});

describe("LogDrainService", () => {
  it("forbids a viewer from creating a drain", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient permission")) } as unknown as TeamAccessService;
    await expect(make(prisma, access).svc.create("u1", "s1", { name: "x", type: "http", endpoint: "https://x" })).rejects.toThrow(/insufficient permission/);
  });

  it("encrypts the token on create, stores the type, and re-pushes the server's drains", async () => {
    const create = jest.fn().mockResolvedValue(row({ name: "axiom", type: "datadog", authTokenEnc: "enc:tok" }));
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) }, logDrain: { create } } as unknown as PrismaService;
    const { svc, push } = make(prisma, okAccess());
    const view = await svc.create("u1", "s1", { name: "axiom", type: "datadog", endpoint: "https://x", token: "tok" });
    expect(create.mock.calls[0][0].data).toMatchObject({ type: "datadog", authTokenEnc: "enc:tok", serverId: "s1", containers: [] });
    expect(create.mock.calls[0][0].data.options).toBeUndefined();
    expect(view).toMatchObject({ hasToken: true, type: "datadog", scope: "server", appId: null, containers: [], options: null, allowPrivate: false, delivery: "pending", status: null });
    expect(push.pushToAgent).toHaveBeenCalledWith("s1");
  });

  it("create stores the container glob filter and the normalised NET options", async () => {
    const create = jest.fn().mockResolvedValue(row({ type: "syslog", endpoint: "logs.example.com:514" }));
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) }, logDrain: { create } } as unknown as PrismaService;
    await make(prisma, okAccess()).svc.create("u1", "s1", {
      name: "s", type: "syslog", endpoint: "logs.example.com:514", containers: ["tugra_db_*"], options: { proto: "udp" },
    });
    expect(create.mock.calls[0][0].data.containers).toEqual(["tugra_db_*"]);
    expect(create.mock.calls[0][0].data.options).toEqual({ proto: "udp", facility: 16 }); // defaults filled
  });

  it("create refuses a bad shape (non-http scheme, syslog without options) before any write", async () => {
    const create = jest.fn();
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) }, logDrain: { create } } as unknown as PrismaService;
    const { svc } = make(prisma, okAccess());
    await expect(svc.create("u1", "s1", { name: "x", type: "http", endpoint: "ftp://x" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create("u1", "s1", { name: "x", type: "syslog", endpoint: "h:514" })).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it("list returns only server-wide drains (appId null) for the server", async () => {
    const findMany = jest.fn().mockResolvedValue([row()]);
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) }, logDrain: { findMany } } as unknown as PrismaService;
    const out = await make(prisma, okAccess()).svc.list("u1", "s1");
    expect(findMany).toHaveBeenCalledWith({ where: { serverId: "s1", appId: null }, orderBy: { createdAt: "asc" } });
    expect(out).toHaveLength(1);
  });

  it("removes a drain and re-pushes config", async () => {
    const del = jest.fn().mockResolvedValue({});
    const prisma = {
      logDrain: { findUnique: jest.fn().mockResolvedValue(row()), delete: del },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
    } as unknown as PrismaService;
    const { svc, push } = make(prisma, okAccess());
    await svc.remove("u1", "d1");
    expect(del).toHaveBeenCalledWith({ where: { id: "d1" } });
    expect(push.pushToAgent).toHaveBeenCalledWith("s1");
  });

  it("update changes the type within the http family when provided, leaves it when omitted", async () => {
    const update = jest.fn().mockResolvedValue(row({ type: "loki" }));
    const prisma = {
      logDrain: { findUnique: jest.fn().mockResolvedValue(row()), update },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
    } as unknown as PrismaService;
    const { svc } = make(prisma, okAccess());
    await svc.update("u1", "d1", { type: "loki" });
    expect(update.mock.calls[0][0].data.type).toBe("loki");
    await svc.update("u1", "d1", { name: "renamed" });
    expect(update.mock.calls[1][0].data.type).toBeUndefined();
  });

  it("an `enabled` toggle or rename does NOT re-validate a legacy row (an old non-http(s) endpoint stays editable)", async () => {
    const update = jest.fn().mockResolvedValue(row());
    const legacy = row({ endpoint: "ftp://legacy.example", type: "HTTP" });
    const prisma = {
      logDrain: { findUnique: jest.fn().mockResolvedValue(legacy), update },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
    } as unknown as PrismaService;
    const { svc } = make(prisma, okAccess());
    await svc.update("u1", "d1", { enabled: false });
    await svc.update("u1", "d1", { name: "x" });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0].data.options).toBeUndefined(); // shape untouched
    // ...but writing a new endpoint IS validated
    await expect(svc.update("u1", "d1", { endpoint: "ftp://still-bad" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("changing between http and a NET type needs the endpoint (and the NET options) in the same request", async () => {
    const update = jest.fn().mockResolvedValue(row({ type: "gelf" }));
    const prisma = {
      logDrain: { findUnique: jest.fn().mockResolvedValue(row()), update },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
    } as unknown as PrismaService;
    const { svc } = make(prisma, okAccess());
    await expect(svc.update("u1", "d1", { type: "gelf" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update("u1", "d1", { type: "gelf", endpoint: "h.example.com:12201" })).rejects.toBeInstanceOf(BadRequestException); // no options
    await svc.update("u1", "d1", { type: "gelf", endpoint: "h.example.com:12201", options: { proto: "udp" } });
    expect(update.mock.calls[0][0].data).toMatchObject({ type: "gelf", endpoint: "h.example.com:12201", options: { proto: "udp", compress: "gzip" } });
  });

  it("a token cannot be added to a syslog/gelf drain", async () => {
    const prisma = {
      logDrain: { findUnique: jest.fn().mockResolvedValue(row({ type: "syslog", endpoint: "h.example.com:514", options: { proto: "udp", facility: 16 } })), update: jest.fn() },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
    } as unknown as PrismaService;
    await expect(make(prisma, okAccess()).svc.update("u1", "d1", { token: "secret" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("server PUT/DELETE 404 on an APP-scoped drain and on a drain of another server", async () => {
    const appDrain = row({ appId: "app1" });
    const otherServer = row({ serverId: "s9" });
    const findUnique = jest.fn().mockResolvedValueOnce(appDrain).mockResolvedValueOnce(otherServer).mockResolvedValueOnce(appDrain).mockResolvedValueOnce(otherServer);
    const prisma = { logDrain: { findUnique, update: jest.fn(), delete: jest.fn() }, server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const { svc, push } = make(prisma, okAccess());
    await expect(svc.update("u1", "d1", { name: "x" }, "s1")).rejects.toBeInstanceOf(NotFoundException); // app drain
    await expect(svc.update("u1", "d1", { name: "x" }, "s1")).rejects.toBeInstanceOf(NotFoundException); // mismatched :id
    await expect(svc.remove("u1", "d1", "s1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove("u1", "d1", "s1")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.logDrain.update).not.toHaveBeenCalled();
    expect(prisma.logDrain.delete).not.toHaveBeenCalled();
    expect(push.pushToAgent).not.toHaveBeenCalled();
  });

  it("listApps: app drains targeting this server (own + cluster branch), WITHOUT endpoint/options/containers/token", async () => {
    const findMany = jest.fn().mockResolvedValue([row({ appId: "app1", app: { name: "Shop" }, endpoint: "https://secret", authTokenEnc: "enc:k", containers: ["web"], options: { a: 1 } })]);
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ ...server, clusterId: "c1" }) },
      logDrain: { findMany },
    } as unknown as PrismaService;
    const out = await make(prisma, okAccess()).svc.listApps("u1", "s1");
    expect(findMany.mock.calls[0][0].where).toEqual({
      appId: { not: null },
      OR: [{ app: { serverId: "s1", clusterId: null } }, { app: { clusterId: "c1" } }],
    });
    expect(out).toEqual([{ id: "d1", name: "n", type: "http", enabled: true, appId: "app1", appName: "Shop", delivery: "pending" }]);
    expect(JSON.stringify(out)).not.toMatch(/secret|enc:k|options|containers/);
  });

  it("listApps needs servers:ops", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    await expect(make(prisma, access).svc.listApps("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "servers:ops");
  });

  it("schema defaults type to http, accepts the NET types and rejects an unknown type", () => {
    expect(CreateLogDrainSchema.parse({ name: "n", endpoint: "https://x" }).type).toBe("http");
    expect(CreateLogDrainSchema.safeParse({ name: "n", endpoint: "h:514", type: "syslog", options: { proto: "udp" } }).success).toBe(true);
    expect(CreateLogDrainSchema.safeParse({ name: "n", endpoint: "h:1", type: "carrier-pigeon" }).success).toBe(false);
    expect(UpdateLogDrainSchema.safeParse({ options: null }).success).toBe(true);
    expect(CreateLogDrainSchema.safeParse({ name: "n", endpoint: "https://x", containers: new Array(33).fill("a") }).success).toBe(false);
  });
});
