import { EgressIpService } from "./egress-ip.service";

function make(env: Record<string, string | undefined>, server: unknown, now = { t: 1_000_000 }) {
  const findFirst = jest.fn(async () => {
    if (server instanceof Error) throw server;
    return server;
  });
  const svc = new EgressIpService({ get: (k: string) => env[k] } as never, { server: { findFirst } } as never);
  svc.now = () => now.t;
  return { svc, findFirst, now };
}

describe("EgressIpService", () => {
  it("the operator override wins and the database is not asked", async () => {
    const { svc, findFirst } = make({ IMPORT_EGRESS_IP: " 198.51.100.4 " }, { publicIp: "203.0.113.7" });
    await expect(svc.resolve()).resolves.toEqual({ ip: "198.51.100.4", source: "env" });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("accepts a private override (a LAN-only source sees the private address) and canonicalises a mapped one", async () => {
    await expect(make({ IMPORT_EGRESS_IP: "10.0.0.5" }, null).svc.resolve()).resolves.toEqual({ ip: "10.0.0.5", source: "env" });
    await expect(make({ IMPORT_EGRESS_IP: "::ffff:198.51.100.4" }, null).svc.resolve()).resolves.toEqual({ ip: "198.51.100.4", source: "env" });
  });

  it("a garbage override is ignored and the server record is used", async () => {
    const { svc } = make({ IMPORT_EGRESS_IP: "not-an-ip" }, { publicIp: "203.0.113.7", publicIpv6: null });
    await expect(svc.resolve()).resolves.toEqual({ ip: "203.0.113.7", source: "server" });
  });

  it("uses the hub's own (isLocal) server's public address, preferring IPv4, and asks only for local servers", async () => {
    const { svc, findFirst } = make({}, { publicIp: "203.0.113.7", publicIpv6: "2001:db8::1" });
    await svc.resolve();
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isLocal: true }) }));
    expect((await svc.resolve()).ip).toBe("203.0.113.7");
    await expect(make({}, { publicIp: null, publicIpv6: "2001:4860:4860::8888" }).svc.resolve()).resolves.toEqual({ ip: "2001:4860:4860::8888", source: "server" });
  });

  it("a private or garbage address on the record is never reported as the egress address", async () => {
    await expect(make({}, { publicIp: "172.18.0.3", publicIpv6: null }).svc.resolve()).resolves.toEqual({ ip: null, source: "unknown" });
    await expect(make({}, { publicIp: "nonsense", publicIpv6: null }).svc.resolve()).resolves.toEqual({ ip: null, source: "unknown" });
  });

  it("is unknown (not an error) when there is no record or the lookup fails", async () => {
    await expect(make({}, null).svc.resolve()).resolves.toEqual({ ip: null, source: "unknown" });
    const failing = make({}, new Error("db down"));
    await expect(failing.svc.resolve()).resolves.toEqual({ ip: null, source: "unknown" });
    await expect(failing.svc.ip()).resolves.toBeNull();
  });

  it("resolves once and caches: 10 min when known, 1 min when unknown", async () => {
    const known = make({}, { publicIp: "203.0.113.7" });
    await known.svc.resolve();
    known.now.t += 9 * 60_000;
    await known.svc.resolve();
    expect(known.findFirst).toHaveBeenCalledTimes(1);
    known.now.t += 2 * 60_000;
    await known.svc.resolve();
    expect(known.findFirst).toHaveBeenCalledTimes(2);

    const unknown = make({}, null);
    await unknown.svc.resolve();
    unknown.now.t += 30_000;
    await unknown.svc.resolve();
    expect(unknown.findFirst).toHaveBeenCalledTimes(1);
    unknown.now.t += 31_000;
    await unknown.svc.resolve();
    expect(unknown.findFirst).toHaveBeenCalledTimes(2);
  });
});
