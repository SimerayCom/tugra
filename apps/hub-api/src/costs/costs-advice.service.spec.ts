import { ForbiddenException } from "@nestjs/common";
import { CostsAdviceService } from "./costs-advice.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { CloudProviderFactory } from "../cloud/providers/provider-factory.service";

const GIB = 1024 ** 3;
const DAY = 86_400_000;

const server = (o: Record<string, unknown> = {}) => ({
  id: "s1",
  teamId: "t1",
  name: "web-1",
  isLocal: false,
  provider: null as string | null,
  providerServerId: null as string | null,
  cloudCredentialId: null as string | null,
  cloudHint: "hetzner" as string | null,
  cpuCores: 8,
  memTotalBytes: BigInt(Math.round(15.1 * GIB)),
  arch: "amd64",
  cost: null as unknown,
  ...o,
});

const idleUsage = (o: Record<string, number> = {}) => ({
  serverId: "s1",
  n: 14 * 1440,
  cpu_avg: 4,
  cpu_p95: 10,
  cpu_peak: 25,
  mem_p95_b: 2.5 * GIB,
  mem_peak_b: 3 * GIB,
  mem_p95: 0.16,
  mem_peak: 0.2,
  disk_used_b: 20 * GIB,
  disk_pct: 0.12,
  ...o,
});

function make(o: { servers?: ReturnType<typeof server>[]; usage?: unknown[]; firstDays?: number; catalog?: unknown; catalogError?: boolean; active?: string[] } = {}) {
  const prisma = {
    server: { findMany: jest.fn().mockResolvedValue(o.servers ?? [server()]) },
    metricRollup: { groupBy: jest.fn().mockResolvedValue([{ serverId: "s1", _min: { bucket: new Date(Date.now() - (o.firstDays ?? 20) * DAY) } }]) },
    serverRescale: { findMany: jest.fn().mockResolvedValue((o.active ?? []).map((serverId) => ({ serverId }))) },
    cloudCredential: { findUnique: jest.fn().mockResolvedValue({ id: "cc1", teamId: "t1", provider: "hetzner", apiTokenEnc: "enc:TOKEN" }) },
    $queryRaw: jest.fn().mockImplementation(async (q: { strings?: string[]; sql?: string }) => {
      const text = (q.strings ?? [q.sql ?? ""]).join(" ");
      return text.includes("percentile_cont") ? (o.usage ?? [idleUsage()]) : [{ serverId: "s1", disk: 76 * GIB }];
    }),
  };
  const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:manage"])]])) };
  const crypto = { decrypt: jest.fn().mockImplementation((s: string) => s.replace(/^enc:/, "")) };
  const planClient = {
    listPlanCatalog: o.catalogError ? jest.fn().mockRejectedValue(new Error("down")) : jest.fn().mockResolvedValue(o.catalog ?? []),
  };
  const providers = { getPlans: jest.fn().mockImplementation((p: string) => (p === "hetzner" ? planClient : null)) };
  const svc = new CostsAdviceService(prisma as unknown as PrismaService, access as unknown as TeamAccessService, crypto as unknown as CryptoService, providers as unknown as CloudProviderFactory);
  return { svc, prisma, planClient, providers };
}

describe("CostsAdviceService", () => {
  it("is 'learning' until 14 days of metrics exist, and says how many were collected", async () => {
    const c = make({ firstDays: 6 });
    const [a] = (await c.svc.advice("u1")).advice;
    expect(a).toMatchObject({ kind: "learning", daysNeeded: 14 });
    expect(a.daysCollected).toBeGreaterThan(5.9);
    expect(a.daysCollected).toBeLessThan(6.1);
    expect(a.target).toBeNull();
  });

  it("is 'learning' when the host was mostly silent (too few minutes)", async () => {
    const c = make({ usage: [idleUsage({ n: 3000 })] });
    expect((await c.svc.advice("u1")).advice[0].kind).toBe("learning");
  });

  it("suggests a smaller plan from the dated snapshot when no provider API is connected", async () => {
    const c = make();
    const r = await c.svc.advice("u1");
    const a = r.advice[0];
    expect(a.kind).toBe("downsize");
    expect(a.priceBasis).toBe("list");
    expect(a.current).toMatchObject({ slug: "cx43", cores: 8, memoryGb: 16 });
    expect(a.target?.slug).toBe("cx33"); // 4 vCPU / 8 GB / 80 GB: holds the load and keeps the measured 80 GB disk
    expect(a.diskBlocked).toBe(false);
    expect(a.savingsCents).toBe(1649 - 899);
    expect(a.rescale).toBe("guide");
    expect(r.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.planClient.listPlanCatalog).not.toHaveBeenCalled();
  });

  it("flags a server near its limit", async () => {
    const c = make({ usage: [idleUsage({ cpu_p95: 92, cpu_peak: 100 })] });
    const a = (await c.svc.advice("u1")).advice[0];
    expect(a.kind).toBe("near_limit");
    expect(a.reasons).toEqual(["cpu"]);
  });

  it("uses the provider's live prices and offers one-click rescale when the API is linked", async () => {
    const plan = (slug: string, cores: number, mem: number, disk: number, price: number) => ({ slug, cores, memoryGb: mem, diskGb: disk, architecture: "x86", deprecated: false, monthlyCentsByLocation: { fsn1: price }, currency: "EUR" });
    const c = make({
      servers: [server({ provider: "hetzner", providerServerId: "42", cloudCredentialId: "cc1", cost: { source: "provider", monthlyCents: 1649, currency: "EUR", provider: "hetzner", planSlug: "cx43", location: "fsn1" } })],
      catalog: [plan("cx43", 8, 16, 160, 1649), plan("cpx32", 4, 8, 160, 1200), plan("cx33", 4, 8, 80, 899), plan("cpx52", 12, 24, 480, 8549), plan("cx53", 16, 32, 320, 2999)],
    });
    const a = (await c.svc.advice("u1")).advice[0];
    expect(a.priceBasis).toBe("provider");
    expect(a.kind).toBe("downsize");
    expect(a.target?.slug).toBe("cpx32"); // the only cheaper plan that keeps the 160 GB disk
    expect(a.target?.diskGb ?? 0).toBeGreaterThanOrEqual(160);
    expect(a.diskBlocked).toBe(false);
    expect(a.rescale).toBe("api");
    expect(c.planClient.listPlanCatalog).toHaveBeenCalledWith("TOKEN");
  });

  it("a cheaper plan with a smaller disk is advice only (disks do not shrink): no one-click rescale", async () => {
    const plan = (slug: string, cores: number, mem: number, disk: number, price: number) => ({ slug, cores, memoryGb: mem, diskGb: disk, architecture: "x86", deprecated: false, monthlyCentsByLocation: { fsn1: price }, currency: "EUR" });
    const c = make({
      servers: [server({ provider: "hetzner", providerServerId: "42", cloudCredentialId: "cc1", cost: { source: "provider", monthlyCents: 1649, currency: "EUR", provider: "hetzner", planSlug: "cx43", location: "fsn1" } })],
      catalog: [plan("cx43", 8, 16, 160, 1649), plan("cx33", 4, 8, 80, 899)],
    });
    const a = (await c.svc.advice("u1")).advice[0];
    expect(a).toMatchObject({ kind: "downsize", diskBlocked: true, rescale: "guide" });
    expect(a.target?.slug).toBe("cx33");
  });

  it("reads a credential's catalog at most once per hour across servers and calls", async () => {
    const plan = { slug: "cx43", cores: 8, memoryGb: 16, diskGb: 160, architecture: "x86", deprecated: false, monthlyCentsByLocation: { fsn1: 1649 }, currency: "EUR" };
    const linked = { provider: "hetzner", providerServerId: "42", cloudCredentialId: "cc1", cost: { source: "provider", monthlyCents: 1649, currency: "EUR", provider: "hetzner", planSlug: "cx43", location: "fsn1" } };
    const c = make({ servers: [server(linked), server({ ...linked, id: "s2", name: "b" })], catalog: [plan] });
    await c.svc.advice("u1");
    await c.svc.advice("u1");
    expect(c.planClient.listPlanCatalog).toHaveBeenCalledTimes(1);
  });

  it("falls back to the snapshot (guide only) when the provider catalog cannot be read", async () => {
    const c = make({
      servers: [server({ provider: "hetzner", providerServerId: "42", cloudCredentialId: "cc1", cost: { source: "provider", monthlyCents: 1649, currency: "EUR", provider: "hetzner", planSlug: "cx43", location: "fsn1" } })],
      catalogError: true,
    });
    const a = (await c.svc.advice("u1")).advice[0];
    expect(a.priceBasis).toBe("list");
    expect(a.rescale).toBe("guide");
  });

  it("blocks rescale for the hub's own box and while another rescale runs", async () => {
    expect((await make({ servers: [server({ isLocal: true })] }).svc.advice("u1")).advice[0].rescaleBlocked).toBe("local_hub");
    expect((await make({ active: ["s1"] }).svc.advice("u1")).advice[0].rescaleBlocked).toBe("active");
  });

  it("sorts the servers with something to say first", async () => {
    const c = make({ servers: [server({ id: "s2", name: "aaa" }), server()], usage: [idleUsage(), { ...idleUsage(), serverId: "s2", cpu_p95: 95, cpu_peak: 100 }] });
    c.prisma.metricRollup.groupBy.mockResolvedValue([
      { serverId: "s1", _min: { bucket: new Date(Date.now() - 20 * DAY) } },
      { serverId: "s2", _min: { bucket: new Date(Date.now() - 20 * DAY) } },
    ]);
    const kinds = (await c.svc.advice("u1")).advice.map((a) => a.kind);
    expect(kinds[0]).toBe("near_limit");
  });

  it("refuses a team the caller is not in, and returns nothing for a user without teams", async () => {
    const c = make();
    await expect(c.svc.advice("u1", "other")).rejects.toBeInstanceOf(ForbiddenException);
    (c as unknown as { svc: { access: { permissionsByTeam: jest.Mock } } }).svc["access"].permissionsByTeam.mockResolvedValue(new Map());
    expect((await c.svc.advice("u1")).advice).toEqual([]);
  });
});
