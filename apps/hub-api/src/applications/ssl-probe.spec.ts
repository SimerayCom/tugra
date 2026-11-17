import { sslState, probeSsl, domainSsl, type SslStatus } from "./ssl-probe";

describe("ssl-probe", () => {
  it("classifies cert lifetime by days remaining", () => {
    expect(sslState(90)).toBe("ok");
    expect(sslState(15)).toBe("ok");
    expect(sslState(14)).toBe("expiring");
    expect(sslState(0)).toBe("expiring");
  });

  it("returns an error state for an unresolvable host (graceful)", async () => {
    const r = await probeSsl("nonexistent.invalid.tugra-test", 1000);
    expect(r.state).toBe("error");
    expect(r.daysRemaining).toBeNull();
  });

  it("domainSsl never probes an http-only domain and reports it as none, not error", async () => {
    const probe = jest.fn();
    const r = await domainSsl("hello.1-2-3-4.sslip.io", false, probe);
    expect(r).toEqual({ state: "none", daysRemaining: null, validTo: null, issuer: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it("domainSsl probes an https domain and passes the probe result through (a missing cert stays an error)", async () => {
    const bad: SslStatus = { state: "error", daysRemaining: null, validTo: null, issuer: null };
    const probe = jest.fn().mockResolvedValue(bad);
    expect(await domainSsl("shop.acme.dev", true, probe)).toBe(bad);
    expect(probe).toHaveBeenCalledWith("shop.acme.dev");
  });
});
