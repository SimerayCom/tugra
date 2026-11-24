import { describe, it, expect } from "vitest";
import { addressRows, classifyIp, ipSourceKey } from "./server-addresses";

describe("classifyIp", () => {
  it("separates public from private/loopback/CGNAT/link-local, per family", () => {
    expect(classifyIp("203.0.113.7")).toBe("public");
    for (const ip of ["10.0.0.5", "172.17.0.1", "192.168.1.5", "127.0.0.1", "100.85.1.2", "169.254.1.1"]) expect(classifyIp(ip)).toBe("private");
    expect(classifyIp("172.32.0.1")).toBe("public");
    expect(classifyIp("2001:db8::1")).toBe("public");
    for (const ip of ["fd12::1", "fe80::1", "::1"]) expect(classifyIp(ip)).toBe("private");
    expect(classifyIp("not-an-ip")).toBe("other");
  });
});

describe("addressRows", () => {
  const base = { publicIp: null, publicIpv6: null, ipSource: "observed", reportedIps: [] as string[] };

  it("lists the main IPv4 and IPv6 first with their own sources, then the rest, deduped", () => {
    const rows = addressRows({
      ...base,
      publicIp: "203.0.113.7",
      ipSource: "metadata",
      publicIpv6: "2001:db8::1",
      ipv6Source: "reported",
      reportedIps: ["10.0.0.5", "2001:db8::1", "203.0.113.7", "203.0.113.8"],
    });
    expect(rows.map((r) => r.ip)).toEqual(["203.0.113.7", "2001:db8::1", "10.0.0.5", "203.0.113.8"]);
    expect(rows[0]).toMatchObject({ main: true, family: 4, source: "metadata" });
    expect(rows[1]).toMatchObject({ main: true, family: 6, source: "reported" });
    expect(rows[2]).toMatchObject({ main: false, kind: "private", source: null });
  });
  it("is empty when nothing is known", () => {
    expect(addressRows(base)).toEqual([]);
    expect(addressRows({ ...base, reportedIps: undefined as unknown as string[] })).toEqual([]);
  });
});

describe("ipSourceKey", () => {
  it("maps each source to its own label and unknown values to the observed one", () => {
    expect(ipSourceKey("manual")).toBe("servers.ipSourceManual");
    expect(ipSourceKey("reported")).toBe("servers.ipSourceInterface");
    expect(ipSourceKey("metadata")).toBe("servers.ipSourceMetadata");
    expect(ipSourceKey("observed")).toBe("servers.ipSourceObserved");
    expect(ipSourceKey(undefined)).toBe("servers.ipSourceObserved");
  });
});
