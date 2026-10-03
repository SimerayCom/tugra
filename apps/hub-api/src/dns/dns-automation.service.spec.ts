import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DnsAutomationService } from "./dns-automation.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CloudflareApiClient } from "../tunnel/cloudflare-api.client";
import { SwarmProxyService } from "../clusters/swarm-proxy.service";
import { DnsCredentialsService } from "./dns-credentials.service";
import { DnsLookupService } from "./dns-lookup.service";

const APP = { id: "a1", teamId: "t1", serverId: "s1", clusterId: null as string | null, domain: null as string | null };
const CRED = { token: "CFTOKEN", cfAccountId: null as string | null, provider: "cloudflare", teamId: "t1" };

type Rec = { id: string; type: string; name: string; content: string; proxied?: boolean };

function make(over: {
  app?: Partial<typeof APP>;
  server?: { publicIp: string | null; publicIpv6: string | null } | null;
  cred?: Partial<typeof CRED>;
  credList?: Array<{ id: string; cfAccountId: string | null }>;
  zoneName?: string;
  recordsAt?: (name: string) => Rec[];
  priorRecordIds?: Array<{ type: string; name: string; recordId: string }> | null;
  ingress?: { replicas: number; nodes: Array<{ id: string; name: string; ip: string | null }> };
  resolve4?: string[];
  resolve6?: string[];
  resolve4Throws?: Error;
  createThrowsOn?: string; // content that makes createDnsRecord reject (partial-failure test)
} = {}) {
  const app = { ...APP, ...over.app };
  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(app) },
    server: { findUnique: jest.fn().mockResolvedValue(over.server ?? { publicIp: "203.0.113.7", publicIpv6: null }) },
    domain: {
      findUnique: jest.fn().mockResolvedValue(over.priorRecordIds !== undefined && over.priorRecordIds !== null ? { recordIds: over.priorRecordIds } : null),
      findFirst: jest.fn().mockResolvedValue({ id: "d1", hostname: "example.com" }),
      upsert: jest.fn().mockResolvedValue({ id: "d1" }),
      update: jest.fn().mockResolvedValue({ id: "d1" }),
    },
  } as unknown as PrismaService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const cf = {
    findZoneForHostname: jest.fn().mockResolvedValue({ zoneId: "z1", zoneName: over.zoneName ?? "example.com" }),
    getZoneSslMode: jest.fn().mockResolvedValue("full"),
    listDnsRecords: jest.fn((_t: string, _z: string, f?: { name?: string }) => Promise.resolve(over.recordsAt ? over.recordsAt(f?.name ?? "") : [])),
    upsertDnsRecord: jest.fn((_t, _z, r) => Promise.resolve({ recordId: "upd-" + r.content, action: "updated" })),
    createDnsRecord: jest.fn((_t, _z, r) =>
      over.createThrowsOn && r.content === over.createThrowsOn ? Promise.reject(new Error("cf 403")) : Promise.resolve({ recordId: "new-" + r.content }),
    ),
    deleteDnsRecord: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudflareApiClient;
  const swarmProxy = { ingressInfo: jest.fn().mockResolvedValue(over.ingress ?? { replicas: 1, nodes: [] }) } as unknown as SwarmProxyService;
  const creds = {
    resolveToken: jest.fn().mockResolvedValue({ ...CRED, ...over.cred }),
    cloudflareCredentialsForTeam: jest.fn().mockResolvedValue(over.credList ?? [{ id: "dc1", cfAccountId: null }]),
  } as unknown as DnsCredentialsService;
  const lookup = {
    resolve4: over.resolve4Throws ? jest.fn().mockRejectedValue(over.resolve4Throws) : jest.fn().mockResolvedValue(over.resolve4 ?? []),
    resolve6: jest.fn().mockResolvedValue(over.resolve6 ?? []),
  } as unknown as DnsLookupService;
  const svc = new DnsAutomationService(prisma, access, audit, cf, swarmProxy, creds, lookup);
  return { svc, prisma, audit, access, cf, swarmProxy, creds, lookup };
}

describe("DnsAutomationService.previewRecords", () => {
  it("plans an apex A + www CNAME (DNS-only, proxied=false) for a single-server app, writing nothing + no token leak", async () => {
    const { svc, cf } = make();
    const plan = await svc.previewRecords("u1", "a1", { domain: "example.com" });
    expect(plan.apex).toBe(true);
    expect(plan.records).toEqual([
      { type: "A", name: "example.com", content: "203.0.113.7", proxied: false, action: "create", existingId: null },
      { type: "CNAME", name: "www.example.com", content: "example.com", proxied: false, action: "create", existingId: null },
    ]);
    expect(JSON.stringify(plan)).not.toContain("CFTOKEN"); // the decrypted token is never in the plan
    expect(cf.upsertDnsRecord).not.toHaveBeenCalled();
    expect(cf.createDnsRecord).not.toHaveBeenCalled();
  });

  it("does NOT plan a www CNAME for a subdomain (not an apex)", async () => {
    const { svc } = make({ zoneName: "example.com" });
    const plan = await svc.previewRecords("u1", "a1", { domain: "app.example.com" });
    expect(plan.apex).toBe(false);
    expect(plan.records.map((r) => `${r.type} ${r.name}`)).toEqual(["A app.example.com"]);
  });

  it("marks an already-correct, DNS-only A record as noop (idempotent re-run)", async () => {
    const { svc } = make({ recordsAt: (name) => (name === "example.com" ? [{ id: "r-a", type: "A", name, content: "203.0.113.7", proxied: false }] : []) });
    const plan = await svc.previewRecords("u1", "a1", { domain: "example.com", includeWww: false });
    expect(plan.records).toEqual([{ type: "A", name: "example.com", content: "203.0.113.7", proxied: false, action: "noop", existingId: "r-a" }]);
  });

  it("adopts a content-correct but PROXIED record as an update to DNS-only (not a noop)", async () => {
    const { svc } = make({ recordsAt: (name) => (name === "example.com" ? [{ id: "r-a", type: "A", name, content: "203.0.113.7", proxied: true }] : []) });
    const plan = await svc.previewRecords("u1", "a1", { domain: "example.com", includeWww: false });
    expect(plan.records).toEqual([{ type: "A", name: "example.com", content: "203.0.113.7", proxied: false, action: "update", existingId: "r-a" }]);
  });

  it("flags a foreign A (points elsewhere) as a conflict when overwrite is off, or an update when on", async () => {
    const recordsAt = (name: string) => (name === "example.com" ? [{ id: "r-foreign", type: "A", name, content: "9.9.9.9" }] : []);
    const off = await make({ recordsAt }).svc.previewRecords("u1", "a1", { domain: "example.com", includeWww: false });
    expect(off.records).toContainEqual({ type: "A", name: "example.com", content: "9.9.9.9", proxied: false, action: "conflict", existingId: "r-foreign" });

    const on = await make({ recordsAt }).svc.previewRecords("u1", "a1", { domain: "example.com", includeWww: false, overwrite: true });
    expect(on.records).toEqual([{ type: "A", name: "example.com", content: "203.0.113.7", proxied: false, action: "update", existingId: "r-foreign" }]);
  });

  it("rejects when the server has no public IPv4 (private/CGNAT filtered out)", async () => {
    const { svc } = make({ server: { publicIp: "10.0.0.5", publicIpv6: null } });
    await expect(svc.previewRecords("u1", "a1", { domain: "example.com" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an invalid / wildcard hostname before touching the provider", async () => {
    const { svc, cf } = make();
    await expect(svc.previewRecords("u1", "a1", { domain: "*.example.com" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.previewRecords("u1", "a1", { domain: "not a host" })).rejects.toBeInstanceOf(BadRequestException);
    expect(cf.findZoneForHostname).not.toHaveBeenCalled();
  });

  it("requires apps:deploy on the app's team", async () => {
    const { svc, access } = make();
    await svc.previewRecords("u1", "a1", { domain: "example.com" });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:deploy");
  });

  it("rejects a credential that belongs to another team", async () => {
    const { svc } = make({ cred: { teamId: "OTHER" } });
    await expect(svc.previewRecords("u1", "a1", { domain: "example.com", credentialId: "dc9" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects when the team has no Cloudflare credential, or more than one and none specified", async () => {
    await expect(make({ credList: [] }).svc.previewRecords("u1", "a1", { domain: "example.com" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      make({ credList: [{ id: "dc1", cfAccountId: null }, { id: "dc2", cfAccountId: null }] }).svc.previewRecords("u1", "a1", { domain: "example.com" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("plans one A record per ingress node for a cluster app (round-robin), dropping private IPs", async () => {
    const { svc } = make({
      app: { clusterId: "c1" },
      ingress: { replicas: 2, nodes: [{ id: "n1", name: "a", ip: "203.0.113.7" }, { id: "n2", name: "b", ip: "198.51.100.9" }, { id: "n3", name: "c", ip: "10.0.0.1" }] },
    });
    const plan = await svc.previewRecords("u1", "a1", { domain: "example.com", includeWww: false });
    expect(plan.records.filter((r) => r.type === "A").map((r) => r.content)).toEqual(["203.0.113.7", "198.51.100.9"]);
  });

  it("flags a type-incompatible record (existing CNAME where an A is wanted) as a conflict, but leaves TXT/MX alone", async () => {
    const recordsAt = (name: string) =>
      name === "example.com"
        ? [{ id: "r-cname", type: "CNAME", name, content: "other.example.net" }, { id: "r-txt", type: "TXT", name, content: "v=spf1 -all" }]
        : [];
    const plan = await make({ recordsAt }).svc.previewRecords("u1", "a1", { domain: "example.com", includeWww: false });
    expect(plan.records).toContainEqual({ type: "CNAME", name: "example.com", content: "other.example.net", proxied: false, action: "conflict", existingId: "r-cname" });
    expect(plan.records.some((r) => r.type === "TXT")).toBe(false); // the SPF TXT is never touched
  });
});

describe("DnsAutomationService.applyRecords", () => {
  it("creates the planned records, persists a Domain row (status pending, credential id) and audits without the token", async () => {
    const { svc, cf, prisma, audit } = make();
    const res = await svc.applyRecords("u1", "a1", { domain: "example.com", credentialId: "dc1" });
    expect(res.status).toBe("pending");
    expect(cf.createDnsRecord).toHaveBeenCalledTimes(2); // A + www CNAME
    const upsertArg = (prisma.domain.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertArg.create.status).toBe("pending");
    expect(upsertArg.create.dnsCredentialId).toBe("dc1");
    expect(upsertArg.create.recordIds).toEqual([
      { type: "A", name: "example.com", recordId: "new-203.0.113.7" },
      { type: "CNAME", name: "www.example.com", recordId: "new-example.com" },
    ]);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(auditArg)).not.toContain("CFTOKEN");
    expect(auditArg.meta).toMatchObject({ created: 2 });
  });

  it("persists the AUTO-PICKED credential id when none was specified", async () => {
    const { svc, prisma } = make();
    await svc.applyRecords("u1", "a1", { domain: "example.com", includeWww: false });
    expect((prisma.domain.upsert as jest.Mock).mock.calls[0][0].create.dnsCredentialId).toBe("dc1");
  });

  it("multi-A: keeps the matching record and CREATES the second IP (never overwrites the sibling via found[0])", async () => {
    const { svc, cf } = make({
      app: { clusterId: "c1" },
      ingress: { replicas: 2, nodes: [{ id: "n1", name: "a", ip: "203.0.113.7" }, { id: "n2", name: "b", ip: "198.51.100.9" }] },
      recordsAt: (name) => (name === "example.com" ? [{ id: "r-old", type: "A", name, content: "203.0.113.7", proxied: false }] : []),
    });
    await svc.applyRecords("u1", "a1", { domain: "example.com", includeWww: false });
    expect(cf.createDnsRecord).toHaveBeenCalledTimes(1);
    expect((cf.createDnsRecord as jest.Mock).mock.calls[0][2].content).toBe("198.51.100.9");
    expect(cf.upsertDnsRecord).not.toHaveBeenCalled();
  });

  it("REFUSES (409) to clobber a foreign record unless overwrite is set; with overwrite it repoints it", async () => {
    const recordsAt = (name: string) => (name === "example.com" ? [{ id: "r-foreign", type: "A", name, content: "9.9.9.9" }] : []);
    await expect(make({ recordsAt }).svc.applyRecords("u1", "a1", { domain: "example.com", includeWww: false })).rejects.toBeInstanceOf(ConflictException);

    const ok = make({ recordsAt });
    await ok.svc.applyRecords("u1", "a1", { domain: "example.com", includeWww: false, overwrite: true });
    expect(ok.cf.upsertDnsRecord).toHaveBeenCalledWith("CFTOKEN", "z1", expect.objectContaining({ content: "203.0.113.7", existingRecordId: "r-foreign" }));
  });

  it("deletes a surplus record only under overwrite (and refuses otherwise)", async () => {
    const recordsAt = (name: string) =>
      name === "example.com"
        ? [{ id: "r-keep", type: "A", name, content: "203.0.113.7", proxied: false }, { id: "r-stale", type: "A", name, content: "9.9.9.9" }]
        : [];
    await expect(make({ recordsAt }).svc.applyRecords("u1", "a1", { domain: "example.com", includeWww: false })).rejects.toBeInstanceOf(ConflictException);

    const ow = make({ recordsAt });
    await ow.svc.applyRecords("u1", "a1", { domain: "example.com", includeWww: false, overwrite: true });
    expect(ow.cf.deleteDnsRecord).toHaveBeenCalledWith("CFTOKEN", "z1", "r-stale");
  });

  it("merges prior recordIds on re-apply so an earlier www CNAME is not orphaned", async () => {
    const { svc, prisma } = make({ priorRecordIds: [{ type: "CNAME", name: "www.example.com", recordId: "old-www" }] });
    await svc.applyRecords("u1", "a1", { domain: "example.com", includeWww: false });
    const recordIds = (prisma.domain.upsert as jest.Mock).mock.calls[0][0].update.recordIds;
    expect(recordIds).toContainEqual({ type: "CNAME", name: "www.example.com", recordId: "old-www" });
    expect(recordIds).toContainEqual({ type: "A", name: "example.com", recordId: "new-203.0.113.7" });
  });

  it("on a partial failure persists what was written (status error) and rethrows", async () => {
    const { svc, prisma } = make({ createThrowsOn: "example.com" }); // the www CNAME create fails; the A succeeds
    await expect(svc.applyRecords("u1", "a1", { domain: "example.com" })).rejects.toThrow("cf 403");
    const upsertArg = (prisma.domain.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertArg.create.status).toBe("error");
    expect(upsertArg.create.lastError).toBe("cf 403");
    expect(upsertArg.create.recordIds).toEqual([{ type: "A", name: "example.com", recordId: "new-203.0.113.7" }]);
  });
});

describe("DnsAutomationService.manualRecords", () => {
  it("returns the apex A + www CNAME to create by hand, with no provider call (apps:config)", async () => {
    const { svc, cf, access } = make();
    const out = await svc.manualRecords("u1", "a1", { domain: "example.com" });
    expect(out).toEqual({
      hostname: "example.com",
      records: [
        { type: "A", name: "example.com", content: "203.0.113.7" },
        { type: "CNAME", name: "www.example.com", content: "example.com" },
      ],
    });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
    expect(cf.findZoneForHostname).not.toHaveBeenCalled(); // no provider involvement
  });

  it("omits the www CNAME when includeWww is false and includes AAAA when the server has IPv6", async () => {
    const { svc } = make({ server: { publicIp: "203.0.113.7", publicIpv6: "2001:db8::1" } });
    const out = await svc.manualRecords("u1", "a1", { domain: "app.example.com", includeWww: false });
    expect(out.records).toEqual([
      { type: "A", name: "app.example.com", content: "203.0.113.7" },
      { type: "AAAA", name: "app.example.com", content: "2001:db8::1" },
    ]);
  });

  it("rejects when the server has no public IPv4", async () => {
    const { svc } = make({ server: { publicIp: "10.0.0.5", publicIpv6: null } });
    await expect(svc.manualRecords("u1", "a1", { domain: "example.com" })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("DnsAutomationService.verify", () => {
  it("marks the domain active when every expected A resolves, and persists the status", async () => {
    const { svc, prisma } = make({ resolve4: ["203.0.113.7"] });
    const res = await svc.verify("u1", "a1");
    expect(res.status).toBe("active");
    expect((prisma.domain.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ status: "active", lastError: null });
  });

  it("looks a specific hostname up by (applicationId, hostname) when one is given", async () => {
    const { svc, prisma } = make({ resolve4: ["203.0.113.7"] });
    (prisma.domain.findUnique as jest.Mock).mockResolvedValueOnce({ id: "d2", hostname: "example.com" });
    await svc.verify("u1", "a1", "example.com");
    expect((prisma.domain.findUnique as jest.Mock).mock.calls.at(-1)![0].where).toEqual({ applicationId_hostname: { applicationId: "a1", hostname: "example.com" } });
  });

  it("stays pending while DNS has not propagated", async () => {
    const { svc } = make({ resolve4: [] });
    expect((await svc.verify("u1", "a1")).status).toBe("pending");
  });

  it("records an error (not a throw) when the resolver fails", async () => {
    const { svc, prisma } = make({ resolve4Throws: new Error("SERVFAIL") });
    const res = await svc.verify("u1", "a1");
    expect(res.status).toBe("error");
    expect(res.lastError).toBe("SERVFAIL");
    expect((prisma.domain.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ status: "error", lastError: "SERVFAIL" });
  });

  it("404s when the app has no auto-setup domain", async () => {
    const { svc, prisma } = make();
    (prisma.domain.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(svc.verify("u1", "a1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
