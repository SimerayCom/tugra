import { buildRequest, parseHosts } from "./cutover";

describe("tugra import cutover", () => {
  it("parses a host list", () => {
    expect(parseHosts(" A.com, b.com ,")).toEqual(["a.com", "b.com"]);
    expect(parseHosts(undefined)).toBeUndefined();
  });

  it("maps every action 1:1 to its endpoint", () => {
    expect(buildRequest("init", "op1", { credential: "c1" })).toEqual({ method: "POST", path: "/import/operations/op1/cutover/init", body: { dnsCredentialId: "c1" } });
    expect(buildRequest("status", "op1", {})).toEqual({ method: "GET", path: "/import/operations/op1/cutover" });
    expect(buildRequest("prepare-certs", "op1", { challenge: "dns01", hosts: "a.com" }).body).toEqual({ hostnames: ["a.com"], challenge: "dns01" });
    expect(buildRequest("plan", "op1", { ttl: 120, keepProxied: false }).path).toBe("/import/operations/op1/cutover/flip-plan?targetTtl=120&keepProxied=false");
    expect(buildRequest("exclude", "op1", { hosts: "a.com" }).body).toEqual({ hostnames: ["a.com"], excluded: true });
    expect(buildRequest("include", "op1", { hosts: "a.com" }).body).toEqual({ hostnames: ["a.com"], excluded: false });
  });

  it("flip sends only what was asked and needs the confirm token", () => {
    expect(() => buildRequest("flip", "op1", {})).toThrow(/--confirm/);
    const hash = "a".repeat(64);
    expect(buildRequest("flip", "op1", { confirm: hash }).body).toEqual({ confirmToken: hash });
    expect(buildRequest("flip", "op1", { confirm: hash, batchSize: 3, autoRevert: true, acceptDataRisk: true, stopOnFail: false }).body).toEqual({
      confirmToken: hash, batchSize: 3, autoRevert: true, acceptDataRisk: true, stopOnFail: false,
    });
  });

  it("refuses a revert / seed without the acknowledgement", () => {
    expect(() => buildRequest("revert", "op1", { hosts: "a.com" })).toThrow(/acknowledge-data-loss/);
    expect(buildRequest("revert", "op1", { hosts: "a.com", acknowledgeDataLoss: true, force: true }).body).toEqual({ hostnames: ["a.com"], force: true, acknowledgeDataLoss: true });
    expect(() => buildRequest("seed-certs", "op1", {})).toThrow(/acknowledge-proxy-restart/);
  });

  it("validates fix-counterpart inputs", () => {
    expect(() => buildRequest("fix-counterpart", "op1", { app: "a1", direction: "up" })).toThrow(/direction/);
    expect(buildRequest("fix-counterpart", "op1", { app: "a1", direction: "root" }).body).toEqual({ applicationId: "a1", direction: "root" });
  });
});
