import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppLogDrainService, MAX_APP_DRAINS_PER_SERVER, MAX_DRAINS_PER_APP } from "./app-log-drain.service";
import { LogDrainPushService } from "./log-drain-push.service";

const crypto = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, "") } as unknown as CryptoService;

const APP = { id: "app1", teamId: "t1", serverId: "s1", clusterId: null as string | null, source: "IMAGE" };
const SERVER = { id: "s1", teamId: "tServer" };

const drain = (over: Record<string, unknown> = {}) => ({
  id: "d1", serverId: "s1", appId: "app1", name: "n", type: "http", endpoint: "https://logs.example.com/in", authTokenEnc: null,
  enabled: true, containers: [], options: null, allowPrivate: false, createdAt: new Date(), ...over,
});

interface Opts {
  app?: Record<string, unknown> | null;
  perms?: Record<string, string[]>; // teamId -> permissions the user holds
  existing?: unknown;
  counts?: [number, number]; // [per app, per server]
}

function make(o: Opts = {}) {
  const create = jest.fn(async (args: { data: Record<string, unknown> }) => drain({ ...args.data, id: "dNew" }));
  const update = jest.fn(async (args: { data: Record<string, unknown> }) => drain({ ...((o.existing as object | null | undefined) ?? {}), ...Object.fromEntries(Object.entries(args.data).filter(([, v]) => v !== undefined)) }));
  const del = jest.fn().mockResolvedValue({});
  const count = jest.fn().mockResolvedValueOnce(o.counts?.[0] ?? 0).mockResolvedValueOnce(o.counts?.[1] ?? 0);
  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(o.app === undefined ? APP : o.app) },
    server: { findUnique: jest.fn().mockResolvedValue(SERVER) },
    logDrain: {
      findMany: jest.fn().mockResolvedValue([drain()]),
      findFirst: jest.fn().mockResolvedValue(o.existing === undefined ? drain() : o.existing),
      create, update, delete: del, count,
    },
  } as unknown as PrismaService;
  const perms = o.perms ?? { t1: ["apps:config"], tServer: ["servers:ops"] };
  const requirePermission = jest.fn(async (_u: string, teamId: string, p: string) => {
    if (!(perms[teamId] ?? []).includes(p)) throw new ForbiddenException("insufficient permission for this team");
  });
  const access = { requirePermission } as unknown as TeamAccessService;
  const audit = { log: jest.fn() };
  const push = {
    pushForApp: jest.fn().mockResolvedValue(undefined),
    targetServerIds: jest.fn().mockResolvedValue(["s1"]),
    deliveryFor: jest.fn().mockReturnValue({ delivery: "pending", status: null }),
  };
  const svc = new AppLogDrainService(prisma, access, crypto, audit as unknown as AuditService, push as unknown as LogDrainPushService);
  return { svc, prisma, create, update, del, requirePermission, audit, push };
}

describe("AppLogDrainService: access", () => {
  it("a viewer (no apps:config) gets 403 on every route; a missing app is 404", async () => {
    const { svc } = make({ perms: { t1: [] } });
    await expect(svc.list("u1", "app1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.create("u1", "app1", { name: "n", type: "http", endpoint: "https://x.example.com" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update("u1", "app1", "d1", { name: "x" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove("u1", "app1", "d1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ app: null }).svc.list("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("another app's (or a server-wide) drain id is a 404 on update and delete (looked up WITH the app id)", async () => {
    const { svc, prisma, update, del } = make({ existing: null });
    await expect(svc.update("u1", "app1", "other", { name: "x" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove("u1", "app1", "other")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.logDrain.findFirst).toHaveBeenCalledWith({ where: { id: "other", appId: "app1" } });
    expect(update).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("list returns app-scoped views with delivery computed over the app's target servers, never a token", async () => {
    const { svc, push } = make();
    push.targetServerIds.mockResolvedValue(["s1", "s2"]);
    const [v] = await svc.list("u1", "app1");
    expect(push.deliveryFor).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }), ["s1", "s2"]);
    expect(v).toMatchObject({ scope: "app", appId: "app1", hasToken: false, delivery: "pending" });
    expect(JSON.stringify(v)).not.toContain("authTokenEnc");
  });
});

describe("AppLogDrainService: create", () => {
  const dto = { name: "axiom", type: "http" as const, endpoint: "https://logs.example.com/in" };

  it("anchors the drain on the app's server, encrypts the token, audits without endpoint/token, re-pushes", async () => {
    const { svc, create, audit, push } = make();
    const v = await svc.create("u1", "app1", { ...dto, token: "tok" });
    expect(create.mock.calls[0][0].data).toMatchObject({ serverId: "s1", appId: "app1", authTokenEnc: "enc:tok", allowPrivate: false, containers: [] });
    expect(v).toMatchObject({ scope: "app", hasToken: true });
    expect(audit.log).toHaveBeenCalledWith({ actor: "u1", action: "app.logdrain.create", target: "app1", meta: { drainId: "dNew", type: "http" } });
    expect(JSON.stringify(audit.log.mock.calls)).not.toMatch(/logs\.example\.com|tok/);
    expect(push.pushForApp).toHaveBeenCalledWith(expect.objectContaining({ id: "app1", serverId: "s1" }));
  });

  it("allowPrivate: true needs servers:ops on the team that owns the app's SERVER", async () => {
    const priv = { ...dto, endpoint: "http://10.0.0.5:3100/loki", type: "loki" as const, allowPrivate: true };
    // app writer without servers:ops -> 403, nothing created
    const denied = make({ perms: { t1: ["apps:config"], tServer: [] } });
    await expect(denied.svc.create("u1", "app1", priv)).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.create).not.toHaveBeenCalled();
    expect(denied.requirePermission).toHaveBeenCalledWith("u1", "tServer", "servers:ops");
    // with servers:ops -> created with the flag
    const ok = make();
    await ok.svc.create("u1", "app1", priv);
    expect(ok.create.mock.calls[0][0].data.allowPrivate).toBe(true);
  });

  it("a private literal without allowPrivate is a 400 (hub pre-check); the metadata address is always a 400", async () => {
    const { svc, create } = make();
    await expect(svc.create("u1", "app1", { ...dto, endpoint: "http://10.0.0.5/x" })).rejects.toThrow(/allowPrivate/);
    await expect(svc.create("u1", "app1", { ...dto, endpoint: "http://169.254.169.254/x" })).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
    const priv = make();
    await expect(priv.svc.create("u1", "app1", { ...dto, endpoint: "http://169.254.169.254/x", allowPrivate: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("containers (compose services) are accepted only for a non-clustered COMPOSE app, never silently ignored", async () => {
    const withFilter = { ...dto, containers: ["web"] };
    await expect(make({ app: { ...APP, source: "IMAGE" } }).svc.create("u1", "app1", withFilter)).rejects.toThrow(/compose apps/);
    await expect(make({ app: { ...APP, source: "COMPOSE", clusterId: "c1" } }).svc.create("u1", "app1", withFilter)).rejects.toThrow(/compose apps/);
    const ok = make({ app: { ...APP, source: "COMPOSE" } });
    await ok.svc.create("u1", "app1", withFilter);
    expect(ok.create.mock.calls[0][0].data.containers).toEqual(["web"]);
  });

  it("NET types validate their options (syslog needs proto) and refuse a token for syslog/gelf", async () => {
    const { svc } = make();
    await expect(svc.create("u1", "app1", { name: "s", type: "syslog", endpoint: "logs.example.com:514" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create("u1", "app1", { name: "s", type: "gelf", endpoint: "logs.example.com:12201", options: { proto: "udp" }, token: "x" })).rejects.toThrow(/no authentication/);
    const ok = make();
    await ok.svc.create("u1", "app1", { name: "s", type: "fluentd", endpoint: "fluentd.example.com:24224", options: { proto: "tcp" }, token: "sharedkey" });
    expect(ok.create.mock.calls[0][0].data).toMatchObject({ type: "fluentd", authTokenEnc: "enc:sharedkey", options: { proto: "tcp", tag: "tugra", requireAck: true } });
  });

  it("caps: at most 10 drains per app and 32 app drains per server (counted at create only)", async () => {
    await expect(make({ counts: [MAX_DRAINS_PER_APP, 0] }).svc.create("u1", "app1", dto)).rejects.toThrow(/at most 10/);
    await expect(make({ counts: [0, MAX_APP_DRAINS_PER_SERVER] }).svc.create("u1", "app1", dto)).rejects.toThrow(/at most 32/);
    const ok = make({ counts: [MAX_DRAINS_PER_APP - 1, MAX_APP_DRAINS_PER_SERVER - 1] });
    await ok.svc.create("u1", "app1", dto);
    // the server-wide drains of a server are never counted: the server count is app drains only
    expect(ok.prisma.logDrain.count).toHaveBeenNthCalledWith(2, { where: { serverId: "s1", appId: { not: null } } });
  });
});

describe("AppLogDrainService: update", () => {
  it("name / enabled changes need only apps:config, even on an allowPrivate drain, and skip shape validation", async () => {
    const existing = drain({ allowPrivate: true, endpoint: "http://10.0.0.5/x", type: "loki" });
    const { svc, update, requirePermission } = make({ existing, perms: { t1: ["apps:config"] } });
    await svc.update("u1", "app1", "d1", { name: "renamed", enabled: false });
    expect(update).toHaveBeenCalledTimes(1);
    expect(requirePermission).not.toHaveBeenCalledWith("u1", "tServer", "servers:ops");
    expect(update.mock.calls[0][0].data.options).toBeUndefined();
  });

  it("changing the destination of a drain that has allowPrivate=true needs servers:ops", async () => {
    const existing = drain({ allowPrivate: true, endpoint: "http://10.0.0.5/x", type: "loki" });
    const denied = make({ existing, perms: { t1: ["apps:config"] } });
    for (const dto of [{ endpoint: "http://10.9.9.9/x" }, { token: "t" }, { type: "http" as const }, { options: null }, { containers: [] }]) {
      await expect(denied.svc.update("u1", "app1", "d1", dto)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(denied.update).not.toHaveBeenCalled();
    const ok = make({ existing });
    await ok.svc.update("u1", "app1", "d1", { endpoint: "http://10.9.9.9/x" });
    expect(ok.update).toHaveBeenCalled();
  });

  it("turning allowPrivate ON needs servers:ops; turning it OFF stays apps:config but re-validates the stored endpoint", async () => {
    const plain = drain({ allowPrivate: false });
    await expect(make({ existing: plain, perms: { t1: ["apps:config"] } }).svc.update("u1", "app1", "d1", { allowPrivate: true })).rejects.toBeInstanceOf(ForbiddenException);
    const priv = drain({ allowPrivate: true, endpoint: "http://10.0.0.5/x" });
    // dropping the flag while the stored endpoint is a private literal would leave a dead (agent-blocked) drain: 400
    await expect(make({ existing: priv, perms: { t1: ["apps:config"] } }).svc.update("u1", "app1", "d1", { allowPrivate: false })).rejects.toThrow(/allowPrivate/);
    // with a public endpoint it simply lowers the privilege
    const pub = drain({ allowPrivate: true, endpoint: "https://logs.example.com/x" });
    const ok = make({ existing: pub, perms: { t1: ["apps:config"] } });
    await ok.svc.update("u1", "app1", "d1", { allowPrivate: false });
    expect(ok.update.mock.calls[0][0].data.allowPrivate).toBe(false);
  });

  it("token: undefined keeps, null clears, a string re-encrypts; audit and re-push happen", async () => {
    const h = make();
    await h.svc.update("u1", "app1", "d1", { name: "x" });
    expect(h.update.mock.calls[0][0].data.authTokenEnc).toBeUndefined();
    await h.svc.update("u1", "app1", "d1", { token: null });
    expect(h.update.mock.calls[1][0].data.authTokenEnc).toBeNull();
    await h.svc.update("u1", "app1", "d1", { token: "new" });
    expect(h.update.mock.calls[2][0].data.authTokenEnc).toBe("enc:new");
    expect(h.audit.log).toHaveBeenCalledWith({ actor: "u1", action: "app.logdrain.update", target: "app1", meta: { drainId: "d1", type: "http" } });
    expect(h.push.pushForApp).toHaveBeenCalledTimes(3);
  });

  it("validates containers per the app's source/cluster on update", async () => {
    await expect(make().svc.update("u1", "app1", "d1", { containers: ["web"] })).rejects.toThrow(/compose apps/);
    const ok = make({ app: { ...APP, source: "COMPOSE" } });
    await ok.svc.update("u1", "app1", "d1", { containers: ["web", "worker"] });
    expect(ok.update.mock.calls[0][0].data.containers).toEqual(["web", "worker"]);
  });
});

describe("AppLogDrainService: remove", () => {
  it("deletes the drain, audits and re-pushes (also to cluster members via pushForApp)", async () => {
    const { svc, del, audit, push } = make({ app: { ...APP, clusterId: "c1" } });
    await svc.remove("u1", "app1", "d1");
    expect(del).toHaveBeenCalledWith({ where: { id: "d1" } });
    expect(audit.log).toHaveBeenCalledWith({ actor: "u1", action: "app.logdrain.remove", target: "app1", meta: { drainId: "d1", type: "http" } });
    expect(push.pushForApp).toHaveBeenCalledWith(expect.objectContaining({ id: "app1", clusterId: "c1" }));
  });

  it("a failing re-push never fails the mutation", async () => {
    const { svc, push } = make();
    push.pushForApp.mockRejectedValue(new Error("agent offline"));
    await expect(svc.remove("u1", "app1", "d1")).resolves.toBeUndefined();
  });
});
