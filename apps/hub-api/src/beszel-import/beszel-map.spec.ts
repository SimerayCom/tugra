import { buildHistory, mapAlert, matchSystems, parsePbDate, statsToRollup, statsWindow, type BeszelStatsRecord, type TugraServerLite } from "./beszel-map";

const srv = (id: string, over: Partial<TugraServerLite> = {}): TugraServerLite => ({ id, name: id, hostname: null, publicIp: null, publicIpv6: null, reportedIps: [], ...over });
const sys = (id: string, host: string, name = id) => ({ id, name, host, status: "up" });

describe("matchSystems", () => {
  it("matches by IP first, then host-as-name, then the system's display name", () => {
    const servers = [srv("s1", { publicIp: "203.0.113.5" }), srv("s2", { hostname: "db-1.example.com" }), srv("s3", { name: "Web" })];
    const m = matchSystems([sys("a", "203.0.113.5"), sys("b", "DB-1.example.com"), sys("c", "10.9.9.9", "web")], servers);
    expect(m.get("a")).toMatchObject({ serverId: "s1", by: "ip" });
    expect(m.get("b")).toMatchObject({ serverId: "s2", by: "hostname" });
    expect(m.get("c")).toMatchObject({ serverId: "s3", by: "name" });
  });

  it("uses reported interface IPs and v6 brackets", () => {
    const servers = [srv("s1", { reportedIps: ["10.0.0.7"] }), srv("s2", { publicIpv6: "2001:db8::1" })];
    const m = matchSystems([sys("a", "10.0.0.7"), sys("b", "[2001:db8::1]")], servers);
    expect(m.get("a")).toMatchObject({ serverId: "s1" });
    expect(m.get("b")).toMatchObject({ serverId: "s2" });
  });

  it("leaves ambiguous, duplicate, socket and unknown systems unmatched with a reason", () => {
    const servers = [srv("s1", { publicIp: "203.0.113.5" }), srv("s2", { publicIp: "203.0.113.5" }), srv("s3", { publicIp: "198.51.100.1" })];
    const m = matchSystems([sys("a", "203.0.113.5"), sys("b", "198.51.100.1"), sys("c", "198.51.100.1"), sys("d", "/beszel_socket/beszel.sock"), sys("e", "192.0.2.1")], servers);
    expect(m.get("a")).toEqual({ serverId: null, reason: "ambiguous" });
    expect(m.get("b")).toMatchObject({ serverId: "s3" });
    expect(m.get("c")).toEqual({ serverId: null, reason: "duplicate" });
    expect(m.get("d")).toEqual({ serverId: null, reason: "socket" });
    expect(m.get("e")).toEqual({ serverId: null, reason: "none" });
  });
});

describe("mapAlert", () => {
  it("maps percent alerts to a threshold with min-1 retries on a 60 s check", () => {
    expect(mapAlert({ name: "CPU", value: 80, min: 10 })).toEqual({ kind: "monitor", metric: "CPU", thresholdPct: 80, intervalSec: 60, retries: 9, minutes: 10 });
    expect(mapAlert({ name: "Memory", value: 90.4, min: 1 })).toMatchObject({ metric: "MEM", thresholdPct: 90, retries: 0 });
    expect(mapAlert({ name: "Disk", value: 150, min: 1 })).toMatchObject({ metric: "DISK", thresholdPct: 100 });
  });

  it("maps load, temperature and bandwidth to absolute limits", () => {
    expect(mapAlert({ name: "LoadAvg15", value: 3.456, min: 15 })).toMatchObject({ metric: "LOAD15", thresholdValue: 3.46, retries: 14 });
    expect(mapAlert({ name: "LoadAvg1", value: 2, min: 1 })).toMatchObject({ metric: "LOAD1", thresholdValue: 2 });
    expect(mapAlert({ name: "Temperature", value: 75, min: 5 })).toMatchObject({ metric: "TEMP", thresholdValue: 75 });
    expect(mapAlert({ name: "Bandwidth", value: 20, min: 2 })).toMatchObject({ metric: "NET", thresholdValue: 20 });
  });

  it("clamps the window and treats Status as covered by the built-in offline alert", () => {
    expect(mapAlert({ name: "CPU", value: 50, min: 500 })).toMatchObject({ retries: 59, minutes: 60 });
    expect(mapAlert({ name: "Status", value: 1, min: 3 })).toEqual({ kind: "status", minutes: 3 });
  });

  it("names the reason for alerts it cannot carry", () => {
    expect(mapAlert({ name: "Battery", value: 20, min: 1 })).toEqual({ kind: "skip", reason: "battery" });
    expect(mapAlert({ name: "GPU", value: 90, min: 1 })).toEqual({ kind: "skip", reason: "gpu" });
    expect(mapAlert({ name: "CPUSteal", value: 20, min: 1 })).toEqual({ kind: "skip", reason: "cpuState" });
    expect(mapAlert({ name: "Something new", value: 20, min: 1 })).toEqual({ kind: "skip", reason: "other" });
    expect(mapAlert({ name: "CPU", value: 0, min: 1 })).toEqual({ kind: "skip", reason: "other" });
  });
});

describe("statsToRollup", () => {
  it("reads the newer byte-array stats", () => {
    const r = statsToRollup("2026-11-20 10:00:30.500Z", { cpu: 12.5, cpum: 40, mem: [1000, 400, 0, 0], d: 100, du: 25, b: [10, 20], dio: [1, 2], la: [0.1, 0.2, 0.3], swap: [500, 50] })!;
    expect(r.bucket.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(r).toMatchObject({ avgCpu: 12.5, maxCpu: 40, avgMemTotal: 1000n, avgMemUsed: 400n, avgNetTx: 10n, avgNetRx: 20n, avgDiskRead: 1n, avgDiskWrite: 2n, avgLoad5: 0.2, avgSwapTotal: 500n, avgSwapUsed: 50n });
    expect(r.avgDiskTotal).toBe(BigInt(100 * 1024 ** 3));
  });

  it("reads the older GiB / MB/s stats and keeps unreported optional fields null", () => {
    const r = statsToRollup("2026-11-20 10:00:00Z", { cpu: 5, m: 2, mu: 1, d: 10, du: 5, ns: 1, nr: 2, dr: 3, dw: 4 })!;
    expect(r.avgMemTotal).toBe(BigInt(2 * 1024 ** 3));
    expect(r.avgNetTx).toBe(BigInt(1024 ** 2));
    expect(r.avgNetRx).toBe(BigInt(2 * 1024 ** 2));
    expect(r.avgDiskWrite).toBe(BigInt(4 * 1024 ** 2));
    expect(r.maxCpu).toBe(5);
    expect(r.avgLoad1).toBeNull();
    expect(r.avgSwapUsed).toBeNull();
  });

  it("drops a record without a usable cpu or date", () => {
    expect(statsToRollup("2026-11-20 10:00:00Z", {})).toBeNull();
    expect(statsToRollup("garbage", { cpu: 1 })).toBeNull();
    expect(parsePbDate("2026-11-20 10:00:00.000Z")?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });
});

describe("buildHistory", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString().replace("T", " ");
  const rec = (type: string, msAgo: number, cpu = 1): BeszelStatsRecord => ({ type, created: at(msAgo), stats: { cpu } });
  const H = 3_600_000;
  const D = 24 * H;

  it("keeps each resolution only inside its own window so nothing is counted twice", () => {
    const rows = buildHistory(
      [rec("1m", 30 * 60_000), rec("1m", 2 * H), rec("10m", 3 * H), rec("10m", 30 * 60_000), rec("480m", 10 * D), rec("480m", 31 * D), rec("120m", 2 * D)],
      { now, before: now, floor: now - 30 * D },
    );
    expect(rows).toHaveLength(4); // 1m@30min, 10m@3h, 120m@2d, 480m@10d
    expect(rows.map((r) => r.bucket.getTime())).toEqual([...rows.map((r) => r.bucket.getTime())].sort((a, b) => a - b));
  });

  it("never reaches into data Tugra already has, nor past the rollup retention", () => {
    const rows = buildHistory([rec("480m", 10 * D), rec("480m", 20 * D), rec("480m", 28 * D)], { now, before: now - 15 * D, floor: now - 25 * D });
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket.getTime()).toBe(Math.floor((now - 20 * D) / 60_000) * 60_000);
  });

  it("drops a coarse record that falls inside a finer resolution's window", () => {
    const rows = buildHistory([rec("1m", 30 * 60_000, 11), rec("10m", 30 * 60_000, 22)], { now, before: now, floor: 0 });
    expect(rows.map((r) => r.avgCpu)).toEqual([11]);
    expect(statsWindow("10m", now).end).toBe(statsWindow("1m", now).start);
  });

  it("ignores unknown resolutions", () => {
    expect(buildHistory([{ ...rec("1m", 60_000), type: "5m" }], { now, before: now, floor: 0 })).toEqual([]);
  });
});
