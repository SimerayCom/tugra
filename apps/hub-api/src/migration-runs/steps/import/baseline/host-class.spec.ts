import { classifyHosts, diskReadingOf, gib, isNewerThanTested, lowDisk, osLabel, parseOsRelease, testedOsLabel } from "./host-class";

const GiB = 1024 ** 3;

describe("OS release", () => {
  it("reads the distribution and release from a long name or from two fields", () => {
    expect(parseOsRelease("Ubuntu 26.04.1 LTS")).toEqual({ distro: "ubuntu", major: 26, minor: 4 });
    expect(parseOsRelease("ubuntu", "24.04")).toEqual({ distro: "ubuntu", major: 24, minor: 4 });
    expect(parseOsRelease("Debian GNU/Linux 12 (bookworm)")).toEqual({ distro: "debian", major: 12, minor: 0 });
    expect(parseOsRelease("Alpine 3.20")).toBeNull();
    expect(parseOsRelease(null)).toBeNull();
    expect(parseOsRelease("ubuntu")).toBeNull();
  });

  it("only a release above the newest tested one for a known distribution is flagged", () => {
    const newer = (os: string) => isNewerThanTested(parseOsRelease(os));
    expect(newer("Ubuntu 26.04")).toBe(true);
    expect(newer("Ubuntu 25.10")).toBe(true);
    expect(newer("Ubuntu 24.10")).toBe(true);
    expect(newer("Ubuntu 24.04.4 LTS")).toBe(false);
    expect(newer("Ubuntu 22.04")).toBe(false);
    expect(newer("Debian 13")).toBe(true);
    expect(newer("Debian 12")).toBe(false);
    // the agent reports Debian as its point release: every 12.x is the tested release
    expect(newer("debian 12.9")).toBe(false);
    expect(isNewerThanTested(parseOsRelease("debian", "12.9"))).toBe(false);
    expect(newer("Debian 13.1")).toBe(true);
    expect(isNewerThanTested(null)).toBe(false);
  });

  it("labels are built from the parsed numbers, never from the source's own text", () => {
    expect(osLabel({ distro: "ubuntu", major: 26, minor: 4 })).toBe("ubuntu 26.04");
    expect(osLabel({ distro: "debian", major: 13, minor: 0 })).toBe("debian 13");
    expect(osLabel({ distro: "debian", major: 13, minor: 1 })).toBe("debian 13");
    expect(testedOsLabel()).toBe("ubuntu 24.04, debian 12");
  });
});

describe("disk", () => {
  it("free space is total minus used, with the reading's age", () => {
    const now = Date.parse("2026-11-25T10:00:00Z");
    expect(diskReadingOf({ diskUsed: BigInt(30 * GiB), diskTotal: BigInt(100 * GiB), ts: new Date(now - 90_000) }, now)).toEqual({ freeBytes: 70 * GiB, totalBytes: 100 * GiB, ageSec: 90 });
    expect(diskReadingOf({ diskUsed: BigInt(0), diskTotal: BigInt(0), ts: new Date(now) }, now)).toBeNull();
    expect(diskReadingOf({ diskUsed: BigInt(5), diskTotal: BigInt(1), ts: new Date(now) }, now)).toMatchObject({ freeBytes: 0 });
  });
  it("low means under the floor or under its share of the disk", () => {
    expect(lowDisk({ freeBytes: 9 * GiB, totalBytes: 40 * GiB })).toBe(true);
    expect(lowDisk({ freeBytes: 11 * GiB, totalBytes: 40 * GiB })).toBe(false);
    expect(lowDisk({ freeBytes: 40 * GiB, totalBytes: 1000 * GiB })).toBe(true);
    expect(lowDisk({ freeBytes: 60 * GiB, totalBytes: 1000 * GiB })).toBe(false);
    expect(gib(1.55 * GiB)).toBe(1.6);
  });
});

describe("classifyHosts", () => {
  it("flaky and new-OS flags count only for hosts the run moves; the control plane is always marked", () => {
    const hosts = [
      { ref: "a", name: "host-a", unreachableCount: 5, os: "Ubuntu 26.04" },
      { ref: "b", name: "host-b", unreachableCount: 4 },
      { ref: "c", unreachableCount: 99, os: "Ubuntu 26.04", controlPlane: true as const },
    ];
    const cls = classifyHosts(hosts, new Map([["a", 3], ["b", 1]]));
    expect(cls.flaky).toEqual([{ name: "host-a", count: 5 }]);
    expect(cls.newOs).toEqual([{ name: "host-a", os: "ubuntu 26.04" }]);
    expect(cls.controlPlane).toEqual([{ name: "c", items: 0 }]);
    expect(cls.empty).toEqual(["c"]);
    expect(cls.osReported).toBe(2);
    expect(cls.osUnknown).toEqual(["host-b"]); // moved and silent about its OS; the idle control-plane host is not asked about it
  });
});
