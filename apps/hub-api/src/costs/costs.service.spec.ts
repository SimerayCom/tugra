import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { CostsService, resolveCost } from "./costs.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { CloudProviderFactory } from "../cloud/providers/provider-factory.service";

const GIB = 1024 ** 3;
const baseServer = (o: Record<string, unknown> = {}) => ({
  id: "s1",
  teamId: "t1",
  name: "web-1",
  provider: null as string | null,
  providerServerId: null as string | null,
  cloudCredentialId: null as string | null,
  cloudHint: null as string | null,
  cpuCores: 2,
  memTotalBytes: BigInt(Math.round(3.7 * GIB)),
  arch: "amd64",
  cost: null as unknown,
  ...o,
});

function make(o: { servers?: ReturnType<typeof baseServer>[]; perms?: string[]; scoped?: boolean; plans?: unknown; creds?: unknown } = {}) {
  const servers = o.servers ?? [baseServer()];
  const perms = new Set(o.perms ?? ["servers:manage", "servers:ops"]);
  const prisma = {
    team: { findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "Acme" }]) },
    server: {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: { teamId?: unknown } }) => (typeof where.teamId === "string" ? servers.filter((s) => s.teamId === where.teamId) : servers)),
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => servers.find((s) => s.id === where.id) ?? null),
    },
    application: { findMany: jest.fn().mockResolvedValue([{ id: "app1", name: "Shop", serverId: "s1" }]) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
    containerLabel: { findMany: jest.fn().mockResolvedValue([]) },
    containerMetricRollup: { groupBy: jest.fn().mockResolvedValue([]) },
    costBaseline: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: "b1" }), findUnique: jest.fn(), delete: jest.fn() },
    serverCost: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({}) },
    cloudCredential: { findUnique: jest.fn().mockResolvedValue(o.creds === undefined ? { id: "cc1", teamId: "t1", name: "Prod", provider: "hetzner", apiTokenEnc: "enc:TOKEN" } : o.creds) },
    $queryRaw: jest.fn().mockResolvedValue([{ serverId: "s1", disk: 38 * GIB }]),
  };
  const access = {
    permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", perms]])),
    accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: o.scoped ? "VIEWER" : "OWNER", teamRoleId: null, restrictedAccess: !!o.scoped, accessedProjects: [], accessedResources: [] }]])),
    requirePermission: jest.fn().mockImplementation(async (_u: string, _t: string, p: string) => {
      if (!perms.has(p as never)) throw new ForbiddenException("insufficient permission");
    }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const crypto = { decrypt: jest.fn().mockImplementation((s: string) => s.replace(/^enc:/, "")) };
  const planClient = { listServerPlans: jest.fn().mockResolvedValue(o.plans ?? []) };
  const providers = { getPlans: jest.fn().mockImplementation((p: string) => (p === "hetzner" ? planClient : null)) };
  const svc = new CostsService(prisma as unknown as PrismaService, access as unknown as TeamAccessService, audit as unknown as AuditService, crypto as unknown as CryptoService, providers as unknown as CloudProviderFactory);
  return { svc, prisma, access, audit, crypto, planClient, providers };
}

describe("resolveCost", () => {
  it("prefers a stored provider or manual price over the estimate", () => {
    const r = resolveCost(baseServer({ cost: { source: "manual", monthlyCents: 1234, currency: "EUR", provider: "hetzner", planSlug: "cx23", syncedAt: null } }) as never, 38 * GIB);
    expect(r).toMatchObject({ source: "manual", monthlyCents: 1234, planSlug: "cx23" });
  });
  it("estimates from the snapshot, using the provider the host reports", () => {
    const r = resolveCost(baseServer({ cloudHint: "hetzner" }) as never, 38 * GIB);
    expect(r).toMatchObject({ source: "estimate", provider: "hetzner", planSlug: "cx23", monthlyCents: 599, estimateBasis: "list", currency: "EUR" });
  });
  it("is 'unknown' when the host size is unknown", () => {
    expect(resolveCost(baseServer({ cpuCores: null, memTotalBytes: null }) as never, null).source).toBe("unknown");
  });
});

describe("CostsService.report", () => {
  it("totals per currency, counts estimates, and shows the snapshot date", async () => {
    const c = make({
      servers: [
        baseServer({ id: "s1", cloudHint: "hetzner" }),
        baseServer({ id: "s2", name: "db", cost: { source: "provider", monthlyCents: 1000, currency: "EUR", provider: "hetzner", planSlug: "cx33", syncedAt: new Date("2026-11-20T00:00:00Z") } }),
        baseServer({ id: "s3", name: "us", cost: { source: "manual", monthlyCents: 2000, currency: "USD", provider: null, planSlug: null, syncedAt: null } }),
      ],
    });
    const { teams } = await c.svc.report("u1");
    expect(teams).toHaveLength(1);
    expect(teams[0].totals).toEqual([
      { currency: "EUR", monthlyCents: 1599, estimatedCents: 599, servers: 2 },
      { currency: "USD", monthlyCents: 2000, estimatedCents: 0, servers: 1 },
    ]);
    expect(teams[0].snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(teams[0].canManage).toBe(true);
  });

  it("refuses a team the caller is not in", async () => {
    const c = make();
    await expect(c.svc.report("u1", "other")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("splits the price over apps by resource use and the shares add up", async () => {
    const c = make({ servers: [baseServer({ cloudHint: "hetzner" })] });
    c.prisma.containerMetricRollup.groupBy.mockResolvedValue([
      { serverId: "s1", containerName: "tugra_app1", _sum: { avgCpu: 30, avgMemUsed: BigInt(100) } },
      { serverId: "s1", containerName: "tugra_app1-worker-1", _sum: { avgCpu: 30, avgMemUsed: BigInt(100) } },
      { serverId: "s1", containerName: "tugra-hub-api-1", _sum: { avgCpu: 20, avgMemUsed: BigInt(100) } },
    ]);
    const s = (await c.svc.report("u1")).teams[0].servers[0];
    expect(s.apps.reduce((a, x) => a + x.cents, 0)).toBe(599);
    expect(s.apps[0]).toMatchObject({ key: "app:app1", kind: "app", name: "Shop", resourceId: "app1" });
    expect(s.apps.find((a) => a.kind === "system")).toBeDefined();
  });

  it("hides app names from a restricted viewer", async () => {
    const c = make({ scoped: true, perms: [] });
    c.prisma.containerMetricRollup.groupBy.mockResolvedValue([{ serverId: "s1", containerName: "tugra_app1", _sum: { avgCpu: 30, avgMemUsed: BigInt(100) } }]);
    const s = (await c.svc.report("u1")).teams[0].servers[0];
    expect(s.apps).toEqual([]);
    expect(s.monthlyCents).not.toBeNull();
  });

  it("compares the latest saved bill with today's prices in the same currency", async () => {
    const c = make({ servers: [baseServer({ cost: { source: "manual", monthlyCents: 6000, currency: "EUR", provider: null, planSlug: null, syncedAt: null } })] });
    c.prisma.costBaseline.findMany.mockResolvedValue([{ id: "b1", teamId: "t1", label: "Before", monthlyCents: 20000, currency: "EUR", lines: [{ name: "x", monthlyCents: 20000 }], createdAt: new Date("2026-11-01T00:00:00Z") }]);
    const cmp = (await c.svc.report("u1")).teams[0].comparison;
    expect(cmp).toMatchObject({ beforeCents: 20000, afterCents: 6000, deltaCents: -14000, deltaPct: -70, yearlyDeltaCents: -168000, includesEstimates: false });
  });

  it("gives no comparison across currencies", async () => {
    const c = make({ servers: [baseServer({ cost: { source: "manual", monthlyCents: 6000, currency: "USD", provider: null, planSlug: null, syncedAt: null } })] });
    c.prisma.costBaseline.findMany.mockResolvedValue([{ id: "b1", teamId: "t1", label: "Before", monthlyCents: 20000, currency: "EUR", lines: [], createdAt: new Date() }]);
    expect((await c.svc.report("u1")).teams[0].comparison).toBeNull();
  });
});

describe("CostsService prices", () => {
  it("setServerCost needs servers:manage and stores integer cents as a manual price", async () => {
    const denied = make({ perms: ["servers:ops"] });
    await expect(denied.svc.setServerCost("u1", "s1", { monthly: 12.5, currency: "EUR" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.prisma.serverCost.upsert).not.toHaveBeenCalled();
    const c = make();
    await c.svc.setServerCost("u1", "s1", { monthly: 12.5, currency: "EUR" });
    expect(c.prisma.serverCost.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ serverId: "s1", monthlyCents: 1250, currency: "EUR", source: "manual" }) }));
    expect(c.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.cost.set" }));
  });

  it("an unknown server is a 404", async () => {
    await expect(make().svc.setServerCost("u1", "nope", { monthly: 1, currency: "EUR" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("clearServerCost removes the stored price", async () => {
    const c = make();
    await c.svc.clearServerCost("u1", "s1");
    expect(c.prisma.serverCost.deleteMany).toHaveBeenCalledWith({ where: { serverId: "s1" } });
  });
});

describe("CostsService.sync", () => {
  const linked = baseServer({ provider: "hetzner", providerServerId: "42", cloudCredentialId: "cc1" });
  const plan = (id: string) => ({ providerServerId: id, plan: { slug: "cx23", cores: 2, memoryGb: 4, diskGb: 40, architecture: "x86" }, location: "fsn1", monthlyCents: 410, currency: "EUR" });

  it("needs servers:ops and never touches the provider without it", async () => {
    const c = make({ perms: ["servers:manage"], servers: [linked] });
    await expect(c.svc.sync("u1", "t1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(c.planClient.listServerPlans).not.toHaveBeenCalled();
  });

  it("stores the provider price once per credential, decrypting the token for the call only", async () => {
    const c = make({ servers: [linked, baseServer({ id: "s2", provider: "hetzner", providerServerId: "43", cloudCredentialId: "cc1" })], plans: [plan("42"), plan("43")] });
    const r = await c.svc.sync("u1", "t1");
    expect(r).toEqual({ synced: 2, failed: [] });
    expect(c.planClient.listServerPlans).toHaveBeenCalledTimes(1);
    expect(c.planClient.listServerPlans).toHaveBeenCalledWith("TOKEN");
    expect(c.prisma.serverCost.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ serverId: "s1", source: "provider", monthlyCents: 410, planSlug: "cx23", location: "fsn1" }) }));
    expect(JSON.stringify(c.audit.log.mock.calls)).not.toContain("TOKEN");
  });

  it("never overwrites a price someone typed", async () => {
    const c = make({ servers: [{ ...linked, cost: { source: "manual" } }], plans: [plan("42")] });
    expect((await c.svc.sync("u1", "t1")).synced).toBe(0);
    expect(c.prisma.serverCost.upsert).not.toHaveBeenCalled();
  });

  it("reports a provider failure per credential without leaking the token", async () => {
    const c = make({ servers: [linked] });
    c.planClient.listServerPlans.mockRejectedValue(Object.assign(new Error("hetzner: unauthorized"), { status: 401 }));
    const r = await c.svc.sync("u1", "t1");
    expect(r.synced).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].credentialName).toBe("Prod");
    expect(r.failed[0].message).not.toContain("TOKEN");
  });

  it("skips a credential of another team", async () => {
    const c = make({ servers: [linked], creds: { id: "cc1", teamId: "other", name: "x", provider: "hetzner", apiTokenEnc: "enc:T" } });
    expect((await c.svc.sync("u1", "t1")).synced).toBe(0);
    expect(c.planClient.listServerPlans).not.toHaveBeenCalled();
  });
});

describe("CostsService baselines", () => {
  it("saves the current prices as the before bill", async () => {
    const c = make({ servers: [baseServer({ cloudHint: "hetzner" }), baseServer({ id: "s2", name: "b", cost: { source: "manual", monthlyCents: 1000, currency: "EUR", provider: null, planSlug: null, syncedAt: null } })] });
    await c.svc.createBaseline("u1", { teamId: "t1", label: "Before" });
    expect(c.prisma.costBaseline.create).toHaveBeenCalledWith({ data: expect.objectContaining({ teamId: "t1", label: "Before", monthlyCents: 1599, currency: "EUR", createdBy: "u1", lines: [{ name: "web-1", monthlyCents: 599 }, { name: "b", monthlyCents: 1000 }] }) });
  });

  it("saves a typed total", async () => {
    const c = make();
    await c.svc.createBaseline("u1", { teamId: "t1", monthly: 250, currency: "USD" });
    expect(c.prisma.costBaseline.create).toHaveBeenCalledWith({ data: expect.objectContaining({ monthlyCents: 25000, currency: "USD", lines: [] }) });
  });

  it("refuses to snapshot mixed currencies or no prices, and a team over the cap", async () => {
    const mixed = make({ servers: [baseServer({ cost: { source: "manual", monthlyCents: 1, currency: "EUR", provider: null, planSlug: null, syncedAt: null } }), baseServer({ id: "s2", cost: { source: "manual", monthlyCents: 1, currency: "USD", provider: null, planSlug: null, syncedAt: null } })] });
    await expect(mixed.svc.createBaseline("u1", { teamId: "t1" })).rejects.toBeInstanceOf(BadRequestException);
    const none = make({ servers: [baseServer({ cpuCores: null, memTotalBytes: null })] });
    await expect(none.svc.createBaseline("u1", { teamId: "t1" })).rejects.toBeInstanceOf(BadRequestException);
    const capped = make();
    capped.prisma.costBaseline.count.mockResolvedValue(20);
    await expect(capped.svc.createBaseline("u1", { teamId: "t1", monthly: 1, currency: "EUR" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("needs servers:manage", async () => {
    const c = make({ perms: ["servers:ops"] });
    await expect(c.svc.createBaseline("u1", { teamId: "t1", monthly: 1, currency: "EUR" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("deleting a baseline checks the team of the baseline", async () => {
    const c = make({ perms: ["servers:ops"] });
    c.prisma.costBaseline.findUnique.mockResolvedValue({ id: "b1", teamId: "t1" });
    await expect(c.svc.deleteBaseline("u1", "b1")).rejects.toBeInstanceOf(ForbiddenException);
    c.prisma.costBaseline.findUnique.mockResolvedValue(null);
    await expect(c.svc.deleteBaseline("u1", "zzz")).rejects.toBeInstanceOf(NotFoundException);
  });
});
