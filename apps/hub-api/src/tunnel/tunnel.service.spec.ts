import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { TunnelService } from "./tunnel.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { CloudflareApiClient } from "./cloudflare-api.client";
import type { ModuleRef } from "@nestjs/core";

type Row = Record<string, unknown> | null;

function fullRow(create: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: "cloudflare",
    tunnelId: null,
    cfTunnelTokenEnc: null,
    dnsRecordId: null,
    lastError: null,
    status: "connecting",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...create,
  };
}

function make(opts: {
  server?: Record<string, unknown> | null;
  tunnel?: Record<string, unknown> | null;
  verifyValid?: boolean;
  sendExit?: number;
  sendThrow?: boolean;
  apps?: Array<{ domain: string | null }>;
  app?: Record<string, unknown> | null;
  requirePermThrows?: boolean;
  teamRole?: string | null;
} = {}) {
  const server = opts.server === undefined ? { id: "s1", teamId: "t1", wildcardDomain: null } : opts.server;
  let row: Row = opts.tunnel ?? null;

  const prisma = {
    server: {
      findUnique: jest.fn().mockImplementation((args: { include?: { tunnel?: boolean } }) =>
        Promise.resolve(server === null ? null : { ...server, ...(args?.include?.tunnel ? { tunnel: row } : {}) }),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    serverTunnel: {
      upsert: jest.fn().mockImplementation((args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        row = row ? { ...row, ...args.update } : fullRow(args.create);
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        row = { ...(row as Record<string, unknown>), ...args.data };
        return Promise.resolve(row);
      }),
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(row)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: row ? 1 : 0 }),
    },
    application: {
      findMany: jest.fn().mockResolvedValue(opts.apps ?? []),
      findUnique: jest.fn().mockResolvedValue(opts.app ?? null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;

  const access = {
    requirePermission: opts.requirePermThrows
      ? jest.fn().mockRejectedValue(new ForbiddenException("nope"))
      : jest.fn().mockResolvedValue(undefined),
    teamRole: jest.fn().mockResolvedValue(opts.teamRole === undefined ? "OWNER" : opts.teamRole),
  } as unknown as TeamAccessService;

  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const crypto = {
    encrypt: (s: string) => `enc:${s}`,
    decrypt: (s: string) => s.replace(/^enc:/, ""),
  } as unknown as CryptoService;

  const agentWs = {
    sendCommand: opts.sendThrow
      ? jest.fn().mockRejectedValue(new Error("agent offline"))
      : jest.fn().mockResolvedValue({ exitCode: opts.sendExit ?? 0, output: "" }),
  } as unknown as AgentWsServer;

  const cf = {
    verifyToken: jest.fn().mockResolvedValue({ valid: opts.verifyValid ?? true }),
    findZoneId: jest.fn().mockResolvedValue("zone1"),
    createTunnel: jest.fn().mockResolvedValue({ tunnelId: "tid", token: "connector-token" }),
    putIngressConfig: jest.fn().mockResolvedValue(undefined),
    upsertCname: jest.fn().mockResolvedValue({ recordId: "rec1" }),
    deleteDnsRecord: jest.fn().mockResolvedValue(undefined),
    deleteTunnel: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudflareApiClient;

  const regen = jest.fn().mockResolvedValue(undefined);
  const moduleRef = { get: jest.fn().mockReturnValue({ regenerateMagicForServer: regen }) } as unknown as ModuleRef;

  const service = new TunnelService(prisma, access, audit, crypto, agentWs, cf, moduleRef);
  return { service, prisma, access, audit, crypto, agentWs, cf, moduleRef, regen, getRow: () => row };
}

const input = { apiToken: "cf-api-token-1234567890", cfAccountId: "acc1", zoneName: "example.com" };

describe("TunnelService.setup", () => {
  it("forbids a user without servers:manage — nothing is verified or persisted", async () => {
    const t = make({ requirePermThrows: true });
    await expect(t.service.setup("u1", "s1", input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.cf.verifyToken).not.toHaveBeenCalled();
    expect(t.prisma.serverTunnel.upsert).not.toHaveBeenCalled();
  });

  it("verifies the token BEFORE persisting — an invalid token never reaches the DB", async () => {
    const t = make({ verifyValid: false });
    await expect(t.service.setup("u1", "s1", input)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.cf.verifyToken).toHaveBeenCalled();
    expect(t.prisma.serverTunnel.upsert).not.toHaveBeenCalled();
  });

  it("runs zone → tunnel → wildcardDomain regen → ingress → cname → cloudflared in order", async () => {
    const t = make();
    await t.service.setup("u1", "s1", input);
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    // wildcardDomain regen (server.update) must precede the ingress PUT, so ingress reflects the new magic domains.
    expect(order(t.cf.findZoneId as jest.Mock)).toBeLessThan(order(t.cf.createTunnel as jest.Mock));
    expect(order(t.cf.createTunnel as jest.Mock)).toBeLessThan(order(t.prisma.server.update as jest.Mock));
    expect(order(t.prisma.server.update as jest.Mock)).toBeLessThan(order(t.cf.putIngressConfig as jest.Mock));
    expect(order(t.cf.putIngressConfig as jest.Mock)).toBeLessThan(order(t.cf.upsertCname as jest.Mock));
    expect(order(t.cf.upsertCname as jest.Mock)).toBeLessThan(order(t.agentWs.sendCommand as jest.Mock));
  });

  it("rejects a reconfigure that switches the Cloudflare zone/account while a tunnel exists", async () => {
    const t = make({
      tunnel: { serverId: "s1", zoneName: "old.com", cfAccountId: "acc1", zoneId: "z0", cfApiTokenEnc: "enc:x", tunnelName: "tugra-s1" },
    });
    await expect(t.service.setup("u1", "s1", { ...input, zoneName: "new.com" })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.cf.verifyToken).not.toHaveBeenCalled(); // fails fast, before any CF call
  });

  it("persists the API token ENCRYPTED, never the raw value", async () => {
    const t = make();
    await t.service.setup("u1", "s1", input);
    const createArg = (t.prisma.serverTunnel.upsert as jest.Mock).mock.calls[0][0].create;
    expect(createArg.cfApiTokenEnc).toBe(`enc:${input.apiToken}`);
    expect(createArg.cfApiTokenEnc).not.toBe(input.apiToken);
  });

  it("dispatches the connector setup via the 'deploy' capability", async () => {
    const t = make();
    await t.service.setup("u1", "s1", input);
    const call = (t.agentWs.sendCommand as jest.Mock).mock.calls[0];
    expect(call[2]).toBe("deploy");
    // the connector run-token was decrypted for the agent, not the raw stored ciphertext
    expect(call[1]).not.toContain("enc:");
  });

  it("is idempotent — a resume reuses the stored zoneId/tunnelId instead of re-calling CF", async () => {
    const t = make({
      tunnel: {
        serverId: "s1",
        provider: "cloudflare",
        cfAccountId: "acc1",
        zoneName: "example.com",
        zoneId: "zoneCached",
        cfApiTokenEnc: "enc:old",
        tunnelName: "tugra-s1",
        tunnelId: "existingTid",
        cfTunnelTokenEnc: "enc:connector",
        dnsRecordId: "rec1",
        status: "connected",
        lastError: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    });
    await t.service.setup("u1", "s1", input);
    expect(t.cf.findZoneId).not.toHaveBeenCalled();
    expect(t.cf.createTunnel).not.toHaveBeenCalled();
  });

  it("on agent-dispatch failure: does not throw, records status 'error', CF resources already created", async () => {
    const t = make({ sendThrow: true });
    const view = await t.service.setup("u1", "s1", input);
    expect(t.cf.createTunnel).toHaveBeenCalled(); // CF-side state is durable
    expect(view.status).toBe("error");
    expect(view.lastError).toBeTruthy();
  });

  it("returns a view WITHOUT any encrypted secret fields", async () => {
    const t = make();
    const view = await t.service.setup("u1", "s1", input);
    expect(Object.keys(view)).not.toContain("cfApiTokenEnc");
    expect(Object.keys(view)).not.toContain("cfTunnelTokenEnc");
    expect(JSON.stringify(view)).not.toContain(input.apiToken);
  });

  it("rejects a wildcardDomain that is not the zone or a subdomain of it", async () => {
    const t = make();
    await expect(
      t.service.setup("u1", "s1", { ...input, wildcardDomain: "apps.other.com" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404s when the server does not exist", async () => {
    const t = make({ server: null });
    await expect(t.service.setup("u1", "s1", input)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("TunnelService.status", () => {
  it("returns configured:false when there is no tunnel row", async () => {
    const t = make({ tunnel: null });
    const view = await t.service.status("u1", "s1");
    expect(view.configured).toBe(false);
  });

  it("a plain team member (no servers:manage) can read status", async () => {
    const t = make({ tunnel: { provider: "cloudflare", zoneName: "example.com", tunnelId: "tid", status: "connected", lastError: null, createdAt: new Date(0), updatedAt: new Date(0) } });
    const view = await t.service.status("u1", "s1");
    expect(view.configured).toBe(true);
    expect(t.access.requirePermission).not.toHaveBeenCalled(); // read path uses the weaker team-membership gate
  });
});

describe("TunnelService.teardown", () => {
  const tunnelRow = {
    serverId: "s1",
    cfAccountId: "acc1",
    zoneId: "zone1",
    cfApiTokenEnc: "enc:cf-api-token-1234567890",
    tunnelId: "tid",
    dnsRecordId: "rec1",
    status: "connected",
  };

  it("stops the connector on the agent BEFORE deleting the CF tunnel", async () => {
    const t = make({ tunnel: { ...tunnelRow } });
    await t.service.teardown("u1", "s1");
    const stopOrder = (t.agentWs.sendCommand as jest.Mock).mock.invocationCallOrder[0];
    const delOrder = (t.cf.deleteTunnel as jest.Mock).mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(delOrder);
  });

  it("deletes the DNS record, the CF tunnel, the DB row, and audits", async () => {
    const t = make({ tunnel: { ...tunnelRow } });
    await t.service.teardown("u1", "s1");
    expect(t.cf.deleteDnsRecord).toHaveBeenCalledWith(expect.any(String), "zone1", "rec1");
    expect(t.cf.deleteTunnel).toHaveBeenCalledWith(expect.any(String), "acc1", "tid");
    expect(t.prisma.serverTunnel.deleteMany).toHaveBeenCalledWith({ where: { serverId: "s1" } });
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.tunnel.teardown" }));
  });

  it("tolerates the agent being offline and still completes CF + DB cleanup", async () => {
    const t = make({ tunnel: { ...tunnelRow }, sendThrow: true });
    await expect(t.service.teardown("u1", "s1")).resolves.toBeUndefined();
    expect(t.cf.deleteTunnel).toHaveBeenCalled();
    expect(t.prisma.serverTunnel.deleteMany).toHaveBeenCalled();
  });

  it("clears tunnelExposed on the server's apps when torn down", async () => {
    const t = make({ tunnel: { ...tunnelRow } });
    await t.service.teardown("u1", "s1");
    expect(t.prisma.application.updateMany).toHaveBeenCalledWith({
      where: { serverId: "s1", tunnelExposed: true },
      data: { tunnelExposed: false },
    });
  });

  it("keeps the row and throws (no silent orphan) when Cloudflare cleanup fails", async () => {
    const t = make({ tunnel: { ...tunnelRow } });
    (t.cf.deleteTunnel as jest.Mock).mockRejectedValue(new Error("403 revoked token"));
    await expect(t.service.teardown("u1", "s1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(t.prisma.serverTunnel.deleteMany).not.toHaveBeenCalled(); // row preserved so the orphan is recoverable
    expect(t.prisma.serverTunnel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "error" }) }),
    );
  });

  it("404s when the server does not exist", async () => {
    const t = make({ server: null });
    await expect(t.service.teardown("u1", "s1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("TunnelService.syncIngress", () => {
  it("rebuilds the ingress list from every tunnel-exposed app (DB truth) and PUTs it", async () => {
    const t = make({
      tunnel: { serverId: "s1", cfAccountId: "acc1", tunnelId: "tid", cfApiTokenEnc: "enc:tok" },
      apps: [{ domain: "a.example.com" }, { domain: "b.example.com" }],
    });
    await t.service.syncIngress("s1");
    expect(t.cf.putIngressConfig).toHaveBeenCalledWith("tok", "acc1", "tid", [
      { hostname: "a.example.com", service: "http://tugra-proxy:80" },
      { hostname: "b.example.com", service: "http://tugra-proxy:80" },
    ]);
  });

  it("is a no-op when the server has no tunnel with a tunnelId", async () => {
    const t = make({ tunnel: null });
    await t.service.syncIngress("s1");
    expect(t.cf.putIngressConfig).not.toHaveBeenCalled();
  });
});

describe("TunnelService.setAppExposed", () => {
  const app = { id: "a1", teamId: "t1", serverId: "s1", domain: "a.example.com" };
  const liveTunnel = { serverId: "s1", tunnelId: "tid", cfAccountId: "acc1", cfApiTokenEnc: "enc:tok" };

  it("requires apps:config", async () => {
    const t = make({ app, requirePermThrows: true });
    await expect(t.service.setAppExposed("u1", "a1", true)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("404s when the app does not exist", async () => {
    const t = make({ app: null });
    await expect(t.service.setAppExposed("u1", "a1", true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects enabling when the app's server has no configured tunnel", async () => {
    const t = make({ app, tunnel: null });
    await expect(t.service.setAppExposed("u1", "a1", true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects enabling when the app has no hostname", async () => {
    const t = make({ app: { ...app, domain: null }, tunnel: liveTunnel });
    await expect(t.service.setAppExposed("u1", "a1", true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("enables the app, persists tunnelExposed, re-syncs ingress, and audits", async () => {
    const t = make({ app, tunnel: liveTunnel, apps: [{ domain: "a.example.com" }] });
    await expect(t.service.setAppExposed("u1", "a1", true)).resolves.toEqual({ tunnelExposed: true });
    expect(t.prisma.application.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { tunnelExposed: true } });
    expect(t.cf.putIngressConfig).toHaveBeenCalled();
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.tunnel.update" }));
  });

  it("disabling needs no tunnel and still persists the toggle", async () => {
    const t = make({ app, tunnel: null });
    await expect(t.service.setAppExposed("u1", "a1", false)).resolves.toEqual({ tunnelExposed: false });
    expect(t.prisma.application.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { tunnelExposed: false } });
  });
});
