import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ProvisioningService, isPubliclyReachableUrl } from "./provisioning.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { ServersService } from "../servers/servers.service";
import { CloudProviderFactory } from "./providers/provider-factory.service";

const TOKEN = "APITOKEN_SECRET_xyz";
const cred = { id: "cc1", teamId: "t1", provider: "hetzner", apiTokenEnc: "enc" };
const dto = { teamId: "t1", name: "web", cloudCredentialId: "cc1", provider: "hetzner" as const, location: "nbg1", serverType: "cx22" };

function make(over: { createServer?: jest.Mock; access?: Partial<TeamAccessService>; credRow?: unknown } = {}) {
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const crypto = { decrypt: jest.fn().mockReturnValue(TOKEN), encrypt: jest.fn() } as unknown as CryptoService;
  const client = {
    createServer: over.createServer ?? jest.fn().mockResolvedValue({ providerServerId: "42", publicIp: "1.2.3.4", publicIpv6: null }),
    destroyServer: jest.fn().mockResolvedValue(undefined),
    verifyToken: jest.fn(),
  };
  const providers = { get: jest.fn().mockReturnValue(client) } as unknown as CloudProviderFactory;
  const prisma = {
    cloudCredential: { findUnique: jest.fn().mockResolvedValue("credRow" in over ? over.credRow : cred) },
    server: { update: jest.fn(), delete: jest.fn().mockResolvedValue(undefined) },
  } as unknown as PrismaService;
  const access = over.access ?? ({ requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService);
  const servers = {
    createServer: jest.fn().mockResolvedValue({
      server: { id: "s1", teamId: "t1" },
      enrollToken: "tugra_en_ABC",
      installCommand: "curl -fsSL https://hub.example.com/install/agent.sh | sh -s -- --hub wss://hub.example.com/agent --token tugra_en_ABC",
    }),
    getForUser: jest.fn().mockResolvedValue({ id: "s1", name: "web", status: "PENDING" }),
  } as unknown as ServersService;
  const svc = new ProvisioningService(prisma as PrismaService, access as TeamAccessService, audit, crypto, servers, providers);
  return { svc, prisma, access, crypto, servers, providers, client, audit };
}

describe("isPubliclyReachableUrl", () => {
  it("rejects localhost / private / bad; accepts public host + IP", () => {
    expect(isPubliclyReachableUrl("http://localhost:3000")).toBe(false);
    expect(isPubliclyReachableUrl("https://hub.local")).toBe(false);
    expect(isPubliclyReachableUrl("http://127.0.0.1")).toBe(false);
    expect(isPubliclyReachableUrl("http://192.168.1.5")).toBe(false);
    expect(isPubliclyReachableUrl("not a url")).toBe(false);
    expect(isPubliclyReachableUrl("https://hub.example.com")).toBe(true);
    expect(isPubliclyReachableUrl("https://5.6.7.8")).toBe(true);
  });
});

describe("ProvisioningService.provision", () => {
  const saved = process.env.HUB_PUBLIC_URL;
  beforeEach(() => (process.env.HUB_PUBLIC_URL = "https://hub.example.com"));
  afterEach(() => (saved === undefined ? delete process.env.HUB_PUBLIC_URL : (process.env.HUB_PUBLIC_URL = saved)));

  it("provisions: creates the row, calls the provider with cloud-init carrying the enroll token, updates the row", async () => {
    const { svc, servers, client, prisma } = make();
    const res = await svc.provision("u1", dto);
    // row created with the provisioning link
    expect((servers.createServer as jest.Mock).mock.calls[0]).toEqual(["u1", "web", "t1", "https://hub.example.com", { provider: "hetzner", cloudCredentialId: "cc1" }]);
    // cloud-init passed to the provider contains the enroll one-liner (and thus the token)
    const userData = (client.createServer as jest.Mock).mock.calls[0][1].userData as string;
    expect(userData).toContain("--token tugra_en_ABC");
    expect(userData).toContain("get.docker.com");
    // row updated with provider id + ip
    expect((prisma.server!.update as jest.Mock)).toHaveBeenCalledWith({ where: { id: "s1" }, data: { providerServerId: "42", publicIp: "1.2.3.4", publicIpv6: null } });
    expect(res).toMatchObject({ id: "s1" });
  });

  it("rejects when HUB_PUBLIC_URL is not publicly reachable (no DB writes)", async () => {
    process.env.HUB_PUBLIC_URL = "http://localhost:3000";
    const { svc, servers } = make();
    await expect(svc.provision("u1", dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(servers.createServer as jest.Mock).not.toHaveBeenCalled();
  });

  it("rejects an unknown location / server type", async () => {
    const { svc } = make();
    await expect(svc.provision("u1", { ...dto, location: "moon" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.provision("u1", { ...dto, serverType: "cx11" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404s a credential from another team", async () => {
    const { svc } = make({ credRow: { id: "cc1", teamId: "OTHER", provider: "hetzner", apiTokenEnc: "enc" } });
    await expect(svc.provision("u1", dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("forbids a non-manager", async () => {
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    const { svc } = make({ access });
    await expect(svc.provision("u1", dto)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("tears down the VM and drops the row if persisting the provider result fails (no orphaned billing VM)", async () => {
    const { svc, prisma, client } = make();
    (prisma.server!.update as jest.Mock).mockRejectedValue(new Error("db connection lost"));
    let err: Error | undefined;
    try {
      await svc.provision("u1", dto);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(client.destroyServer as jest.Mock).toHaveBeenCalledWith(TOKEN, "42"); // VM torn down (no DB needed)
    expect(prisma.server!.delete as jest.Mock).toHaveBeenCalledWith({ where: { id: "s1" } });
  });

  it("compensates (deletes the row) when the provider create fails, without leaking the token", async () => {
    const createServer = jest.fn().mockRejectedValue(new Error("hetzner: server_type is invalid"));
    const { svc, prisma } = make({ createServer });
    let err: Error | undefined;
    try {
      await svc.provision("u1", dto);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err!.message).not.toContain(TOKEN);
    expect((prisma.server!.delete as jest.Mock)).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(prisma.server!.update as jest.Mock).not.toHaveBeenCalled();
  });
});

describe("ProvisioningService.destroyVm", () => {
  it("no-ops when the credential is already gone", async () => {
    const { svc, client, prisma } = make({ credRow: null });
    await svc.destroyVm("hetzner", "cc1", "42");
    expect(client.destroyServer as jest.Mock).not.toHaveBeenCalled();
    expect(prisma.cloudCredential!.findUnique as jest.Mock).toHaveBeenCalled();
  });

  it("destroys the VM with the decrypted token", async () => {
    const { svc, client, crypto } = make();
    await svc.destroyVm("hetzner", "cc1", "42");
    expect(crypto.decrypt).toHaveBeenCalledWith("enc");
    expect(client.destroyServer as jest.Mock).toHaveBeenCalledWith(TOKEN, "42");
  });
});
