import { BadRequestException, ConflictException } from "@nestjs/common";
import { MailDnsService, type MailDnsRequest } from "./mail-dns.service";
import { AuditService } from "../audit/audit.service";
import { CloudflareApiClient } from "../tunnel/cloudflare-api.client";
import { DnsCredentialsService } from "./dns-credentials.service";

type Rec = { id: string; type: string; name: string; content: string; proxied?: boolean; priority?: number };

const CRED = { token: "CFTOKEN", cfAccountId: null as string | null, provider: "cloudflare", teamId: "t1" };

function make(
  over: {
    cred?: Partial<typeof CRED>;
    recordsAt?: (name: string, type?: string) => Rec[];
    zoneName?: string;
    resolveTokenThrows?: Error;
    createThrowsOnType?: string; // make createDnsRecord reject for this record type (partial-failure test)
  } = {},
) {
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const cf = {
    findZoneForHostname: jest.fn().mockResolvedValue({ zoneId: "z1", zoneName: over.zoneName ?? "example.com" }),
    listDnsRecords: jest.fn((_t: string, _z: string, f?: { name?: string; type?: string }) =>
      Promise.resolve(over.recordsAt ? over.recordsAt(f?.name ?? "", f?.type) : []),
    ),
    createDnsRecord: jest.fn((_t, _z, r) =>
      over.createThrowsOnType && r.type === over.createThrowsOnType ? Promise.reject(new Error("cf 503")) : Promise.resolve({ recordId: "new-" + r.type + "-" + r.name }),
    ),
    upsertDnsRecord: jest.fn((_t, _z, r) => Promise.resolve({ recordId: "upd-" + r.type + "-" + r.name, action: "updated" })),
    deleteDnsRecord: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudflareApiClient;
  const creds = {
    resolveToken: over.resolveTokenThrows
      ? jest.fn().mockRejectedValue(over.resolveTokenThrows)
      : jest.fn().mockResolvedValue({ ...CRED, ...over.cred }),
  } as unknown as DnsCredentialsService;
  const svc = new MailDnsService(audit, cf, creds);
  return { svc, audit, cf, creds };
}

const REQ: MailDnsRequest = { credentialId: "dc1", domain: "example.com", mailHost: "mail.example.com" };

describe("MailDnsService.previewMailRecords", () => {
  it("plans create actions for MX + SPF + monitor-first DMARC on an empty zone, writing nothing + no token leak", async () => {
    const { svc, cf } = make();
    const plan = await svc.previewMailRecords("u1", REQ);
    expect(plan.domain).toBe("example.com");
    expect(plan.mailHost).toBe("mail.example.com");
    expect(plan.records.map((r) => `${r.purpose}:${r.action}`)).toEqual(["mx:create", "spf:create", "dmarc:create"]);
    const mx = plan.records.find((r) => r.purpose === "mx")!;
    expect(mx).toMatchObject({ type: "MX", name: "example.com", content: "mail.example.com.", priority: 10 });
    expect(JSON.stringify(plan)).not.toContain("CFTOKEN");
    expect(cf.createDnsRecord).not.toHaveBeenCalled();
    expect(cf.upsertDnsRecord).not.toHaveBeenCalled();
  });

  it("includes a DKIM create when the mail server's public key is supplied", async () => {
    const { svc } = make();
    const plan = await svc.previewMailRecords("u1", { ...REQ, dkim: { selector: "dkim", publicKey: "v=DKIM1; k=rsa; p=MIIBI..." } });
    const dkim = plan.records.find((r) => r.purpose === "dkim")!;
    expect(dkim).toMatchObject({ type: "TXT", name: "dkim._domainkey.example.com", action: "create" });
  });

  it("marks an already-correct MX + SPF as noop (idempotent re-run), even when CF stores the MX host without a trailing dot", async () => {
    const { svc } = make({
      recordsAt: (name, type) => {
        if (type === "MX" && name === "example.com") return [{ id: "mx1", type: "MX", name, content: "mail.example.com", priority: 10 }];
        if (type === "TXT" && name === "example.com") return [{ id: "spf1", type: "TXT", name, content: "v=spf1 mx ~all" }];
        return [];
      },
    });
    const plan = await svc.previewMailRecords("u1", REQ);
    const byPurpose = Object.fromEntries(plan.records.map((r) => [r.purpose, r.action]));
    expect(byPurpose.mx).toBe("noop");
    expect(byPurpose.spf).toBe("noop");
    expect(byPurpose.dmarc).toBe("create");
  });

  it("leaves our MX at a different priority as noop WITHOUT overwrite (respects a deliberate backup ordering), updates WITH overwrite", async () => {
    const recordsAt = (name: string, type?: string) =>
      type === "MX" && name === "example.com" ? [{ id: "mx1", type: "MX", name, content: "mail.example.com", priority: 20 }] : [];
    const noOw = await make({ recordsAt }).svc.previewMailRecords("u1", REQ);
    expect(noOw.records.find((r) => r.purpose === "mx")).toMatchObject({ action: "noop", existingId: "mx1" });
    const ow = await make({ recordsAt }).svc.previewMailRecords("u1", { ...REQ, overwrite: true });
    expect(ow.records.find((r) => r.purpose === "mx")).toMatchObject({ action: "update", existingId: "mx1", priority: 10 });
  });

  it("normalizes QUOTED Cloudflare TXT content: an existing quoted SPF identical to ours is a noop (idempotent), a different quoted SPF is a conflict", async () => {
    const noop = await make({
      recordsAt: (name, type) => (type === "TXT" && name === "example.com" ? [{ id: "spf1", type: "TXT", name, content: '"v=spf1 mx ~all"' }] : []),
    }).svc.previewMailRecords("u1", REQ);
    expect(noop.records.find((r) => r.purpose === "spf")).toMatchObject({ action: "noop", existingId: "spf1" });
    const conflict = await make({
      recordsAt: (name, type) => (type === "TXT" && name === "example.com" ? [{ id: "spf1", type: "TXT", name, content: '"v=spf1 include:_spf.google.com ~all"' }] : []),
    }).svc.previewMailRecords("u1", REQ);
    expect(conflict.records.find((r) => r.purpose === "spf")).toMatchObject({ action: "conflict", existingId: "spf1" });
  });

  it("treats a CHUNKED Cloudflare DKIM TXT (\"part1\" \"part2\") equal to our key as a noop", async () => {
    const key = "v=DKIM1; k=rsa; p=AAAABBBBCCCC";
    const { svc } = make({
      recordsAt: (name, type) =>
        type === "TXT" && name === "dkim._domainkey.example.com" ? [{ id: "dk1", type: "TXT", name, content: '"v=DKIM1; k=rsa; p=AAAA" "BBBBCCCC"' }] : [],
    });
    const plan = await svc.previewMailRecords("u1", { ...REQ, dkim: { selector: "dkim", publicKey: key } });
    expect(plan.records.find((r) => r.purpose === "dkim")).toMatchObject({ action: "noop", existingId: "dk1" });
  });

  it("flags a CNAME sitting at the DKIM name as a conflict (CF would reject a TXT there) instead of planning a doomed create", async () => {
    const { svc } = make({
      recordsAt: (name, type) =>
        type === "CNAME" && name === "dkim._domainkey.example.com" ? [{ id: "cn1", type: "CNAME", name, content: "dkim.provider.example." }] : [],
    });
    const plan = await svc.previewMailRecords("u1", { ...REQ, dkim: { selector: "dkim", publicKey: "v=DKIM1; k=rsa; p=X" } });
    expect(plan.records.find((r) => r.purpose === "dkim")).toMatchObject({ action: "conflict", existingId: "cn1" });
  });

  it("collapses a split foreign MX under overwrite: repoints the first + deletes the rest", async () => {
    const { svc } = make({
      recordsAt: (name, type) =>
        type === "MX" && name === "example.com"
          ? [
              { id: "mxA", type: "MX", name, content: "mx1.other.com", priority: 5 },
              { id: "mxB", type: "MX", name, content: "mx2.other.com", priority: 10 },
            ]
          : [],
    });
    const plan = await svc.previewMailRecords("u1", { ...REQ, overwrite: true });
    const mx = plan.records.filter((r) => r.purpose === "mx");
    expect(mx.map((r) => r.action).sort()).toEqual(["delete", "update"]);
    expect(mx.find((r) => r.action === "update")).toMatchObject({ existingId: "mxA" });
    expect(mx.find((r) => r.action === "delete")).toMatchObject({ existingId: "mxB" });
  });

  it("IGNORES unrelated TXT at the apex (a domain-verification token) — it plans a fresh SPF create, never a conflict", async () => {
    const { svc } = make({
      recordsAt: (name, type) =>
        type === "TXT" && name === "example.com"
          ? [{ id: "ver", type: "TXT", name, content: "google-site-verification=abc123" }]
          : [],
    });
    const plan = await svc.previewMailRecords("u1", REQ);
    const spf = plan.records.find((r) => r.purpose === "spf")!;
    expect(spf.action).toBe("create"); // the verification TXT is not in the SPF slot
  });

  it("flags a FOREIGN MX / SPF as a conflict (does not clobber a domain that already receives mail) without overwrite", async () => {
    const { svc } = make({
      recordsAt: (name, type) => {
        if (type === "MX" && name === "example.com") return [{ id: "mx1", type: "MX", name, content: "mx.other.com", priority: 10 }];
        if (type === "TXT" && name === "example.com") return [{ id: "spf1", type: "TXT", name, content: "v=spf1 include:_spf.google.com ~all" }];
        return [];
      },
    });
    const plan = await svc.previewMailRecords("u1", REQ);
    expect(plan.records.find((r) => r.purpose === "mx")).toMatchObject({ action: "conflict", existingId: "mx1", existingContent: "mx.other.com" });
    expect(plan.records.find((r) => r.purpose === "spf")).toMatchObject({ action: "conflict", existingId: "spf1" });
  });

  it("repoints a foreign MX/SPF (update) when overwrite is set", async () => {
    const { svc } = make({
      recordsAt: (name, type) => (type === "MX" && name === "example.com" ? [{ id: "mx1", type: "MX", name, content: "mx.other.com", priority: 10 }] : []),
    });
    const plan = await svc.previewMailRecords("u1", { ...REQ, overwrite: true });
    expect(plan.records.find((r) => r.purpose === "mx")).toMatchObject({ action: "update", existingId: "mx1" });
  });

  it("rejects a non-cloudflare credential (400)", async () => {
    const { svc } = make({ cred: { provider: "route53" } });
    await expect(svc.previewMailRecords("u1", REQ)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps an invalid domain/mailHost from the builder to a 400", async () => {
    const { svc } = make();
    await expect(svc.previewMailRecords("u1", { ...REQ, mailHost: "localhost" })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("MailDnsService.applyMailRecords", () => {
  it("creates MX (with priority) + SPF + DMARC and audits the operation without leaking the token", async () => {
    const { svc, cf, audit } = make();
    const res = await svc.applyMailRecords("u1", REQ);
    expect(res.records.map((r) => `${r.purpose}:${r.action}`)).toEqual(["mx:created", "spf:created", "dmarc:created"]);
    const mxCall = (cf.createDnsRecord as jest.Mock).mock.calls.find((c) => c[2].type === "MX");
    expect(mxCall[2]).toMatchObject({ type: "MX", content: "mail.example.com.", priority: 10, proxied: false });
    const spfCall = (cf.createDnsRecord as jest.Mock).mock.calls.find((c) => c[2].type === "TXT" && c[2].content.startsWith("v=spf1"));
    expect(spfCall[2].priority).toBeUndefined(); // TXT carries no priority (the client omits it from the body)
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "dns.mail.apply", target: "example.com" }));
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("CFTOKEN");
  });

  it("refuses to apply when any record conflicts (no overwrite) and writes nothing", async () => {
    const { svc, cf } = make({
      recordsAt: (name, type) => (type === "MX" && name === "example.com" ? [{ id: "mx1", type: "MX", name, content: "mx.other.com", priority: 10 }] : []),
    });
    await expect(svc.applyMailRecords("u1", REQ)).rejects.toBeInstanceOf(ConflictException);
    expect(cf.createDnsRecord).not.toHaveBeenCalled();
    expect(cf.upsertDnsRecord).not.toHaveBeenCalled();
  });

  it("keeps an already-correct record (noop → kept) instead of re-creating it", async () => {
    const { svc, cf } = make({
      recordsAt: (name, type) => (type === "MX" && name === "example.com" ? [{ id: "mx1", type: "MX", name, content: "mail.example.com.", priority: 10 }] : []),
    });
    const res = await svc.applyMailRecords("u1", REQ);
    expect(res.records.find((r) => r.purpose === "mx")).toMatchObject({ action: "kept", recordId: "mx1" });
    expect((cf.createDnsRecord as jest.Mock).mock.calls.some((c) => c[2].type === "MX")).toBe(false);
  });

  it("deletes the surplus foreign MX under overwrite (collapse) and reports it as deleted", async () => {
    const { svc, cf } = make({
      createThrowsOnType: undefined,
      recordsAt: (name, type) =>
        type === "MX" && name === "example.com"
          ? [
              { id: "mxA", type: "MX", name, content: "mx1.other.com", priority: 5 },
              { id: "mxB", type: "MX", name, content: "mx2.other.com", priority: 10 },
            ]
          : [],
    });
    const res = await svc.applyMailRecords("u1", { ...REQ, overwrite: true });
    expect(cf.deleteDnsRecord).toHaveBeenCalledWith("CFTOKEN", "z1", "mxB");
    expect(res.records.find((r) => r.action === "deleted")).toMatchObject({ purpose: "mx", recordId: "mxB" });
  });

  it("records a PARTIAL apply in the audit log (partial:true) when a later create throws, then rethrows", async () => {
    const { svc, audit, cf } = make({ createThrowsOnType: "TXT" }); // MX creates, the first TXT (SPF) fails
    await expect(svc.applyMailRecords("u1", REQ)).rejects.toThrow(/cf 503/);
    const call = (audit.log as jest.Mock).mock.calls.find((c) => c[0].meta?.partial === true);
    expect(call).toBeTruthy();
    expect(call[0]).toMatchObject({ action: "dns.mail.apply", target: "example.com" });
    expect(call[0].meta.applied).toEqual([{ purpose: "mx", recordId: "new-MX-example.com", action: "created" }]);
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("CFTOKEN");
    expect(cf.createDnsRecord).toHaveBeenCalled();
  });
});
