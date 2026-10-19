import { buildMailDnsRecords } from "./mail-dns";

describe("buildMailDnsRecords", () => {
  it("builds MX + SPF + monitor-first DMARC for a basic setup", () => {
    const r = buildMailDnsRecords({ domain: "example.com", mailHost: "mail.example.com" });
    expect(r.find((x) => x.purpose === "mx")).toEqual({ type: "MX", name: "example.com", content: "mail.example.com.", priority: 10, purpose: "mx" });
    expect(r.find((x) => x.purpose === "spf")).toMatchObject({ type: "TXT", name: "example.com", content: "v=spf1 mx ~all" });
    expect(r.find((x) => x.purpose === "dmarc")).toMatchObject({ type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=none; rua=mailto:postmaster@example.com; adkim=s; aspf=s" });
    expect(r.some((x) => x.purpose === "dkim")).toBe(false); // none without a key
  });

  it("publishes a DKIM record when the mail server's key is supplied", () => {
    const r = buildMailDnsRecords({ domain: "example.com", mailHost: "mail.example.com", dkim: { selector: "dkim", publicKey: "v=DKIM1; k=rsa; p=MIIBI..." } });
    expect(r.find((x) => x.purpose === "dkim")).toEqual({ type: "TXT", name: "dkim._domainkey.example.com", content: "v=DKIM1; k=rsa; p=MIIBI...", purpose: "dkim" });
  });

  it("honors an explicit DMARC policy + report address", () => {
    const r = buildMailDnsRecords({ domain: "a.io", mailHost: "mx.a.io", dmarcPolicy: "quarantine", dmarcReportTo: "dmarc@a.io" });
    expect(r.find((x) => x.purpose === "dmarc")!.content).toBe("v=DMARC1; p=quarantine; rua=mailto:dmarc@a.io; adkim=s; aspf=s");
  });

  it("normalizes trailing dots + case", () => {
    const r = buildMailDnsRecords({ domain: "Example.COM.", mailHost: "Mail.Example.com." });
    expect(r.find((x) => x.purpose === "mx")).toMatchObject({ name: "example.com", content: "mail.example.com." });
  });

  it("rejects an invalid domain, mail host, DKIM selector, or report address", () => {
    expect(() => buildMailDnsRecords({ domain: "not a domain", mailHost: "mail.example.com" })).toThrow(/invalid mail domain/);
    expect(() => buildMailDnsRecords({ domain: "example.com", mailHost: "localhost" })).toThrow(/invalid mail host/); // single label
    expect(() => buildMailDnsRecords({ domain: "example.com", mailHost: "mail.example.com", dkim: { selector: "bad selector", publicKey: "k" } })).toThrow(/invalid DKIM selector/);
    expect(() => buildMailDnsRecords({ domain: "example.com", mailHost: "mail.example.com", dmarcReportTo: "notanemail" })).toThrow(/invalid DMARC report/);
  });

  it("hardens against injected DMARC tags / targets and a malformed policy or selector", () => {
    // a ';' or ',' in the report address must not inject extra DMARC tags / report destinations
    expect(() => buildMailDnsRecords({ domain: "example.com", mailHost: "mail.example.com", dmarcReportTo: "a@b.com;p=reject" })).toThrow(/invalid DMARC report/);
    expect(() => buildMailDnsRecords({ domain: "example.com", mailHost: "mail.example.com", dmarcReportTo: "a@b.com,mailto:x@evil.com" })).toThrow(/invalid DMARC report/);
    expect(() => buildMailDnsRecords({ domain: "example.com", mailHost: "mail.example.com", dmarcPolicy: "none; pct=0" as never })).toThrow(/invalid DMARC policy/);
    expect(() => buildMailDnsRecords({ domain: "example.com", mailHost: "mail.example.com", dkim: { selector: "a..b", publicKey: "k" } })).toThrow(/invalid DKIM selector/);
  });
});
