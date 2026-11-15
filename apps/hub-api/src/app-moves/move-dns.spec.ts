import { repointMoveDomains } from "./move-dns";

const rec = (action: string, existingId: string | null, type = "A") => ({ type, name: "x", content: "5.6.7.8", proxied: false, action, existingId });
function make(domains: unknown[], plan: (input: { domain: string }) => { records: unknown[] }) {
  const previewRecords = jest.fn(async (_u: string, _a: string, input: { domain: string }) => plan(input));
  const applyRecords = jest.fn().mockResolvedValue({});
  const db = { domain: { findMany: jest.fn().mockResolvedValue(domains) } };
  return { deps: { db, dns: { previewRecords, applyRecords } as never }, previewRecords, applyRecords };
}
const owned = (...ids: string[]) => ids.map((recordId) => ({ type: "A", name: "app.example.com", recordId, created: true }));

describe("repointMoveDomains", () => {
  it("repoints an auto-managed domain whose ONLY conflicting records are the ones Tugra wrote, with overwrite", async () => {
    const t = make([{ id: "d1", hostname: "app.example.com", mode: "auto", dnsCredentialId: "cred1", recordIds: owned("r1") }], () => ({ records: [rec("conflict", "r1")] }));
    const r = await repointMoveDomains(t.deps as never, "app1", "u1");
    expect(r).toEqual({ repointed: ["app.example.com"], failed: [], manual: [] });
    expect(t.applyRecords).toHaveBeenCalledWith("u1", "app1", { domain: "app.example.com", credentialId: "cred1", includeWww: false, overwrite: true });
    // the preview never overwrites
    expect(t.previewRecords.mock.calls[0][2]).not.toHaveProperty("overwrite");
  });

  it("applies WITHOUT overwrite when nothing conflicts (the records already point there or are simply missing)", async () => {
    const t = make([{ id: "d1", hostname: "app.example.com", mode: "auto", dnsCredentialId: null, recordIds: owned("r1") }], () => ({ records: [rec("update", "r1")] }));
    await repointMoveDomains(t.deps as never, "app1", "u1");
    expect(t.applyRecords).toHaveBeenCalledWith("u1", "app1", { domain: "app.example.com", credentialId: undefined, includeWww: false, overwrite: false });
  });

  it("NEVER overwrites a record Tugra did not write: a foreign conflicting record makes the domain a failure (manual follow-up)", async () => {
    const t = make([{ id: "d1", hostname: "app.example.com", mode: "auto", dnsCredentialId: "c", recordIds: owned("r1") }], () => ({ records: [rec("conflict", "r1"), rec("conflict", "someone-elses")] }));
    const r = await repointMoveDomains(t.deps as never, "app1", "u1");
    expect(r.failed).toEqual(["app.example.com"]);
    expect(t.applyRecords).not.toHaveBeenCalled();
  });

  it("a conflict without an id is treated as foreign", async () => {
    const t = make([{ id: "d1", hostname: "a.example.com", mode: "auto", dnsCredentialId: "c", recordIds: owned("r1") }], () => ({ records: [rec("conflict", null)] }));
    expect((await repointMoveDomains(t.deps as never, "app1", "u1")).failed).toEqual(["a.example.com"]);
    expect(t.applyRecords).not.toHaveBeenCalled();
  });

  it("manual-mode domains and domains without recorded address records are left to the operator", async () => {
    const t = make(
      [
        { id: "d1", hostname: "manual.example.com", mode: "manual", dnsCredentialId: null, recordIds: owned("r1") },
        { id: "d2", hostname: "norecords.example.com", mode: "auto", dnsCredentialId: null, recordIds: null },
        { id: "d3", hostname: "cnameonly.example.com", mode: "auto", dnsCredentialId: null, recordIds: [{ type: "CNAME", name: "www.x", recordId: "r9" }] },
      ],
      () => ({ records: [] }),
    );
    const r = await repointMoveDomains(t.deps as never, "app1", "u1");
    expect(r.manual).toEqual(["manual.example.com", "norecords.example.com", "cnameonly.example.com"]);
    expect(t.previewRecords).not.toHaveBeenCalled();
  });

  it("includeWww follows the recorded www record; a provider error on one domain does not stop the others", async () => {
    const t = make(
      [
        { id: "d1", hostname: "boom.example.com", mode: "auto", dnsCredentialId: "c", recordIds: owned("r1") },
        { id: "d2", hostname: "ok.example.com", mode: "auto", dnsCredentialId: "c", recordIds: [...owned("r2"), { type: "CNAME", name: "www.ok.example.com", recordId: "r3" }] },
      ],
      (input) => {
        if (input.domain === "boom.example.com") throw new Error("cloudflare 500");
        return { records: [] };
      },
    );
    const r = await repointMoveDomains(t.deps as never, "app1", "u1");
    expect(r).toEqual({ repointed: ["ok.example.com"], failed: ["boom.example.com"], manual: [] });
    expect(t.applyRecords).toHaveBeenCalledWith("u1", "app1", expect.objectContaining({ domain: "ok.example.com", includeWww: true }));
  });

  it("an app with no Domain rows is a no-op", async () => {
    const t = make([], () => ({ records: [] }));
    expect(await repointMoveDomains(t.deps as never, "app1", "u1")).toEqual({ repointed: [], failed: [], manual: [] });
  });
});
