import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import { RescaleService } from "./rescale.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { CloudProviderFactory } from "../cloud/providers/provider-factory.service";

const TOKEN = "hz-secret-token";
const baseServer = (o: Record<string, unknown> = {}) => ({
  id: "s1",
  teamId: "t1",
  name: "web-1",
  isLocal: false,
  provider: "hetzner",
  providerServerId: "42",
  cloudCredentialId: "cc1",
  ...o,
});
const plan = (slug: string, disk = 80, arch = "x86") => ({ slug, cores: 4, memoryGb: 8, diskGb: disk, architecture: arch });
const catalogPlan = (slug: string, disk: number, o: Record<string, unknown> = {}) => ({ ...plan(slug, disk), deprecated: false, monthlyCentsByLocation: { fsn1: 900 }, currency: "EUR", ...o });

function make(o: { server?: ReturnType<typeof baseServer> | null; perms?: string[]; status?: string; locked?: boolean; current?: string; catalog?: unknown[]; existing?: unknown; cost?: unknown } = {}) {
  const perms = new Set(o.perms ?? ["servers:manage"]);
  const rows = new Map<string, Record<string, unknown>>();
  let n = 0;
  const server = o.server === undefined ? baseServer() : o.server;
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue(server) },
    cloudCredential: { findUnique: jest.fn().mockResolvedValue({ id: "cc1", teamId: "t1", apiTokenEnc: `enc:${TOKEN}` }) },
    serverRescale: {
      findFirst: jest.fn().mockResolvedValue(o.existing ?? null),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `r${++n}`, phase: "SHUTTING_DOWN", error: null, upgradeDisk: false, startedAt: new Date(), updatedAt: new Date(), finishedAt: null, ...data };
        rows.set(row.id, row);
        return row;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      update: jest.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("gone");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    serverCost: { findUnique: jest.fn().mockResolvedValue(o.cost ?? null), upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({}) },
  };
  const state = { status: o.status ?? "running", locked: o.locked ?? false, slug: o.current ?? "cx43" };
  const calls: string[] = [];
  const oob = {
    name: "hetzner",
    getServerState: jest.fn().mockImplementation(async () => ({ providerServerId: "42", name: "web-1", status: state.status, locked: state.locked, rescueEnabled: false, publicIpv4: null, publicIpv6: null })),
    power: jest.fn().mockImplementation(async (_t: string, _id: string, action: string) => {
      calls.push(`power:${action}`);
      return { id: "1", status: "running", command: action };
    }),
  };
  const plans = {
    name: "hetzner",
    getServerPlan: jest.fn().mockImplementation(async () => ({ providerServerId: "42", plan: plan(state.slug, 160), location: "fsn1", monthlyCents: 1649, currency: "EUR" })),
    listPlanCatalog: jest.fn().mockResolvedValue(o.catalog ?? [catalogPlan("cx43", 160), catalogPlan("cpx32", 160), catalogPlan("cx33", 80)]),
    changeType: jest.fn().mockImplementation(async (_t: string, _id: string, slug: string, up: boolean) => {
      calls.push(`changeType:${slug}:${up}`);
      return { id: "2", status: "running", command: "change_server_type" };
    }),
  };
  const access = {
    requirePermission: jest.fn().mockImplementation(async (_u: string, _t: string, p: string) => {
      if (!perms.has(p)) throw new ForbiddenException("insufficient permission");
    }),
    membershipPermissions: jest.fn().mockResolvedValue(new Set(["servers:manage"])),
  };
  const audit = { log: jest.fn().mockImplementation(async (e: { action: string }) => void calls.push(`audit:${e.action}`)) };
  const crypto = { decrypt: jest.fn().mockImplementation((s: string) => s.replace(/^enc:/, "")) };
  const providers = { getPlans: jest.fn().mockReturnValue(plans), getOob: jest.fn().mockReturnValue(oob) };
  const svc = new RescaleService(prisma as unknown as PrismaService, access as unknown as TeamAccessService, audit as unknown as AuditService, crypto as unknown as CryptoService, providers as unknown as CloudProviderFactory);
  return { svc, prisma, oob, plans, audit, access, state, calls, rows };
}

const body = { planSlug: "cpx32", confirmName: "web-1" };

describe("RescaleService.start", () => {
  it("needs servers:manage and never touches the provider without it", async () => {
    const c = make({ perms: [] });
    await expect(c.svc.start("u1", "s1", body)).rejects.toBeInstanceOf(ForbiddenException);
    expect(c.plans.getServerPlan).not.toHaveBeenCalled();
    expect(c.oob.power).not.toHaveBeenCalled();
  });

  it("an unknown server is a 404", async () => {
    await expect(make({ server: null }).svc.start("u1", "s1", body)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses the machine the hub runs on", async () => {
    const c = make({ server: baseServer({ isLocal: true }) });
    await expect(c.svc.start("u1", "s1", body)).rejects.toMatchObject({ response: { code: "rescale_local_hub" } });
    expect(c.oob.power).not.toHaveBeenCalled();
  });

  it("needs the server's name typed", async () => {
    const c = make();
    await expect(c.svc.start("u1", "s1", { ...body, confirmName: "nope" })).rejects.toBeInstanceOf(BadRequestException);
    expect(c.plans.getServerPlan).not.toHaveBeenCalled();
  });

  it("a server with no cloud link is a 409", async () => {
    const c = make({ server: baseServer({ provider: null, providerServerId: null, cloudCredentialId: null }) });
    await expect(c.svc.start("u1", "s1", body)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    ["a plan that is not in the catalog", { planSlug: "zzz" }, undefined, "rescale_plan_unavailable"],
    ["a deprecated plan", { planSlug: "cx33" }, [catalogPlan("cx43", 160), catalogPlan("cx33", 80, { deprecated: true })], "rescale_plan_unavailable"],
    ["the plan it already has", { planSlug: "cx43" }, undefined, "rescale_same_plan"],
    ["another processor architecture", { planSlug: "cax21" }, [catalogPlan("cx43", 160), catalogPlan("cax21", 160, { architecture: "arm" })], "rescale_arch_mismatch"],
    ["a smaller disk (disks do not shrink)", { planSlug: "cx33" }, undefined, "rescale_disk_shrink"],
  ])("refuses %s with a 422 and never shuts anything down", async (_n, b, catalog, code) => {
    const c = make({ catalog });
    await expect(c.svc.start("u1", "s1", { ...body, ...b })).rejects.toMatchObject({ response: { code }, status: 422 });
    expect(c.oob.power).not.toHaveBeenCalled();
    expect(c.prisma.serverRescale.create).not.toHaveBeenCalled();
  });

  it("asking to grow the disk skips the local shrink pre-check (the provider decides what it allows)", async () => {
    const c = make();
    const v = await c.svc.start("u1", "s1", { planSlug: "cx33", confirmName: "web-1", upgradeDisk: true });
    expect(v.toPlan).toBe("cx33");
  });

  it("writes the audit entry BEFORE the shutdown, then shuts down gracefully", async () => {
    const c = make();
    const v = await c.svc.start("u1", "s1", body);
    expect(v).toMatchObject({ serverId: "s1", provider: "hetzner", fromPlan: "cx43", toPlan: "cpx32", phase: "SHUTTING_DOWN", error: null });
    expect(c.calls.indexOf("audit:server.rescale.start")).toBeLessThan(c.calls.indexOf("power:shutdown"));
    expect(c.oob.power).toHaveBeenCalledWith(TOKEN, "42", "shutdown");
    expect(JSON.stringify(c.audit.log.mock.calls)).not.toContain(TOKEN);
  });

  it("goes straight to the resize when the server is already off", async () => {
    const c = make({ status: "off" });
    await c.svc.start("u1", "s1", body);
    expect(c.oob.power).not.toHaveBeenCalled();
    expect([...c.rows.values()][0].phase).toBe("RESIZING");
  });

  it("a second rescale for the same server is a 409", async () => {
    const c = make({ existing: { id: "r0" } });
    await expect(c.svc.start("u1", "s1", body)).rejects.toMatchObject({ response: { code: "rescale_active" } });
  });

  it("a failed shutdown call marks the move FAILED and reports the provider's reason without the token", async () => {
    const c = make();
    c.oob.power.mockRejectedValue(Object.assign(new Error("hetzner: server is locked"), { status: 423, hetznerError: { code: "locked" } }));
    await expect(c.svc.start("u1", "s1", body)).rejects.toBeInstanceOf(HttpException);
    const row = [...c.rows.values()][0];
    expect(row.phase).toBe("FAILED");
    expect(String(row.error)).not.toContain(TOKEN);
  });
});

describe("RescaleService.advance", () => {
  async function started(o: Parameters<typeof make>[0] = {}) {
    const c = make(o);
    await c.svc.start("u1", "s1", body);
    c.calls.length = 0;
    c.oob.power.mockClear();
    const row = [...c.rows.values()][0];
    return { c, row, id: row.id as string };
  }

  it("waits while the graceful shutdown is still running, and never forces a power cut", async () => {
    const { c, id, row } = await started();
    await c.svc.advance(id);
    expect(row.phase).toBe("SHUTTING_DOWN");
    expect(c.oob.power).not.toHaveBeenCalled();
    row.updatedAt = new Date(Date.now() - 9 * 60_000);
    await c.svc.advance(id);
    expect(row.phase).toBe("FAILED");
    expect(c.oob.power).not.toHaveBeenCalled();
    expect(c.plans.changeType).not.toHaveBeenCalled();
  });

  it("once the server is off it changes the size, keeping the disk by default", async () => {
    const { c, id, row } = await started();
    c.state.status = "off";
    await c.svc.advance(id);
    expect(row.phase).toBe("RESIZING");
    expect(c.plans.changeType).toHaveBeenCalledWith(TOKEN, "42", "cpx32", false);
  });

  it("asks for the disk to grow only when the move said so", async () => {
    const c = make({ status: "off" });
    await c.svc.start("u1", "s1", { ...body, upgradeDisk: true });
    const id = [...c.rows.values()][0].id as string;
    await c.svc.advance(id);
    expect(c.plans.changeType).toHaveBeenCalledWith(TOKEN, "42", "cpx32", true);
  });

  it("waits while the provider has the server locked, then powers on and finishes with the new price", async () => {
    const { c, id, row } = await started();
    c.state.status = "off"; // the graceful shutdown finished
    await c.svc.advance(id); // asks for the change
    c.plans.changeType.mockClear();
    c.state.locked = true;
    await c.svc.advance(id);
    expect(c.plans.changeType).not.toHaveBeenCalled();
    c.state.locked = false;
    c.state.slug = "cpx32"; // the provider applied the change
    await c.svc.advance(id);
    expect(row.phase).toBe("POWERING_ON");
    await c.svc.advance(id);
    expect(c.oob.power).toHaveBeenCalledWith(TOKEN, "42", "power_on");
    c.state.status = "running";
    await c.svc.advance(id);
    expect(row.phase).toBe("DONE");
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(c.prisma.serverCost.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ serverId: "s1", source: "provider", monthlyCents: 1649 }) }));
    expect(c.calls).toContain("audit:server.rescale.done");
  });

  it("if the change is refused it puts the server back on and reports why", async () => {
    const { c, id, row } = await started();
    c.state.status = "off"; // the graceful shutdown finished
    await c.svc.advance(id);
    c.oob.power.mockClear();
    c.plans.changeType.mockRejectedValue(Object.assign(new Error("hetzner: resource unavailable"), { status: 422, hetznerError: { code: "resource_unavailable" } }));
    await c.svc.advance(id);
    expect(c.oob.power).toHaveBeenCalledWith(TOKEN, "42", "power_on");
    expect(row.phase).toBe("FAILED");
    expect(String(row.error)).toContain("resource unavailable");
    expect(String(row.error)).not.toContain(TOKEN);
  });

  it("a server that was already off stays off: no power-on, even after a refused change", async () => {
    const { c, id, row } = await started({ status: "off" });
    expect(row.wasOff).toBe(true);
    c.plans.changeType.mockRejectedValue(Object.assign(new Error("hetzner: resource unavailable"), { status: 422, hetznerError: { code: "resource_unavailable" } }));
    await c.svc.advance(id);
    expect(c.oob.power).not.toHaveBeenCalled();
    expect(row.phase).toBe("FAILED");

    const d = await started({ status: "off" });
    d.c.state.slug = "cpx32";
    await d.c.svc.advance(d.id);
    expect(d.row.phase).toBe("DONE");
    expect(d.c.oob.power).not.toHaveBeenCalled();
  });

  it("a change that already went through is not reported as a failure when the provider says 'same type'", async () => {
    const { c, id, row } = await started();
    c.state.status = "off";
    await c.svc.advance(id); // RESIZING; change requested
    c.plans.changeType.mockImplementation(async () => {
      c.state.slug = "cpx32"; // applied meanwhile
      throw Object.assign(new Error("hetzner: server type is the same"), { status: 422 });
    });
    c.oob.power.mockClear();
    await c.svc.advance(id);
    expect(row.phase).toBe("RESIZING");
    expect(c.oob.power).not.toHaveBeenCalled();
    await c.svc.advance(id);
    expect(row.phase).toBe("POWERING_ON");
  });

  it("a price the operator typed survives the move", async () => {
    const { c, id, row } = await started({ cost: { source: "manual" } });
    c.state.status = "off";
    await c.svc.advance(id);
    c.state.slug = "cpx32";
    await c.svc.advance(id);
    c.state.status = "running";
    await c.svc.advance(id);
    await c.svc.advance(id);
    expect(row.phase).toBe("DONE");
    expect(c.prisma.serverCost.upsert).not.toHaveBeenCalled();
    expect(c.prisma.serverCost.deleteMany).not.toHaveBeenCalled();
  });

  it("gives up after the total time limit", async () => {
    const { c, id, row } = await started();
    row.startedAt = new Date(Date.now() - 26 * 60_000);
    await c.svc.advance(id);
    expect(row.phase).toBe("FAILED");
  });

  it("a rejected credential ends the move; a network blip is retried", async () => {
    const { c, id, row } = await started();
    c.oob.getServerState.mockRejectedValueOnce(Object.assign(new Error("hetzner api unreachable"), { status: 0 }));
    await c.svc.advance(id);
    expect(row.phase).toBe("SHUTTING_DOWN");
    c.oob.getServerState.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }));
    await c.svc.advance(id);
    expect(row.phase).toBe("FAILED");
  });

  it("a finished move is left alone", async () => {
    const { c, id, row } = await started();
    row.phase = "DONE";
    c.oob.getServerState.mockClear();
    await c.svc.advance(id);
    expect(c.oob.getServerState).not.toHaveBeenCalled();
  });
});

describe("RescaleService.status", () => {
  it("is readable by any member and returns the latest move", async () => {
    const c = make();
    c.prisma.serverRescale.findFirst.mockResolvedValue({ id: "r1", serverId: "s1", provider: "hetzner", fromPlan: "a", toPlan: "b", phase: "DONE", error: null, startedAt: new Date("2026-11-24T00:00:00Z"), finishedAt: new Date("2026-11-24T00:05:00Z") });
    expect((await c.svc.status("u1", "s1")).rescale).toMatchObject({ phase: "DONE", fromPlan: "a", toPlan: "b", finishedAt: "2026-11-24T00:05:00.000Z" });
    c.access.membershipPermissions.mockResolvedValue(null);
    await expect(c.svc.status("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});
