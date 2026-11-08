import { describe, it, expect } from "vitest";
import { aggregateFleetTrend, busiestServers, fleetAttention, fleetSnapshot, trendDelta, DISK_PRESSURE_PCT } from "./dashboard";
import { buildFleetRows } from "./fleet-view";
import { statusFromParam } from "./fleet";
import type { ServerView, Monitor, DomainView, FleetLatestRow, FleetTrendRow } from "./types";

const srv = (id: string, status: ServerView["status"]): ServerView =>
  ({ id, name: `srv-${id}`, status } as ServerView);
const mon = (id: string, status: Monitor["status"]): Monitor =>
  ({ id, name: `mon-${id}`, status } as Monitor);
const dom = (domain: string, appId: string, state: DomainView["ssl"]["state"]): DomainView =>
  ({ domain, appId, ssl: { state } } as DomainView);

describe("fleetAttention", () => {
  it("collects offline servers, down monitors and bad SSL certs, ignoring healthy ones", () => {
    const servers = [srv("a", "ONLINE"), srv("b", "OFFLINE"), srv("c", "PENDING")];
    const monitors = [mon("x", "UP"), mon("y", "DOWN"), mon("z", "PENDING")];
    const domains = [dom("ok.io", "app1", "ok"), dom("exp.io", "app2", "expiring"), dom("bad.io", "app3", "error")];
    const out = fleetAttention(servers, monitors, domains);
    expect(out).toEqual([
      { kind: "server", id: "b", name: "srv-b", status: "OFFLINE" },
      { kind: "monitor", id: "y", name: "mon-y", status: "DOWN" },
      { kind: "domain", id: "app2", name: "exp.io", status: "expiring" }, // link → owning app
      { kind: "domain", id: "app3", name: "bad.io", status: "error" },
    ]);
  });

  it("returns [] when everything is healthy", () => {
    expect(fleetAttention([srv("a", "ONLINE")], [mon("x", "UP")], [dom("ok.io", "a", "ok")])).toEqual([]);
    expect(fleetAttention([], [])).toEqual([]);
  });
});

const NOW = 1_000_000;
const latest = (serverId: string, cpu: number, mem = 50, disk = 40, ts = NOW): FleetLatestRow => ({
  serverId,
  sample: { ts, cpu, memUsed: mem, memTotal: 100, diskUsed: disk, diskTotal: 100, netRx: 0, netTx: 0, diskRead: 0, diskWrite: 0 },
});

describe("aggregateFleetTrend", () => {
  const rows: FleetTrendRow[] = [
    { serverId: "a", points: [{ ts: 60_000, cpu: 10, mem: 40 }, { ts: 120_000, cpu: 20, mem: 50 }] },
    { serverId: "b", points: [{ ts: 60_000, cpu: 30, mem: null }, { ts: 120_000, cpu: 40, mem: 70 }] },
  ];
  it("averages per minute across servers and keeps a NaN hole where no mem was reported", () => {
    const a = aggregateFleetTrend(rows);
    expect(a.times).toEqual([60_000, 120_000]);
    expect(a.cpu).toEqual([20, 30]);
    expect(a.mem).toEqual([40, 60]);
    const lone = aggregateFleetTrend([{ serverId: "b", points: [{ ts: 1, cpu: 5, mem: null }] }]);
    expect(Number.isNaN(lone.mem[0])).toBe(true);
  });
  it("limits to the scoped server ids and tolerates junk / empty input", () => {
    expect(aggregateFleetTrend(rows, new Set(["a"])).cpu).toEqual([10, 20]);
    expect(aggregateFleetTrend(undefined).times).toEqual([]);
    expect(aggregateFleetTrend([{ serverId: "a", points: [{ ts: NaN, cpu: 1, mem: 1 }] }]).times).toEqual([]);
  });
});

describe("trendDelta", () => {
  it("is last series point minus first, flat within 1 point, null without a series", () => {
    expect(trendDelta([10, 20, 30])).toEqual({ delta: 20, dir: "up" });
    expect(trendDelta([50, 40])).toEqual({ delta: -10, dir: "down" });
    expect(trendDelta([50, 50.4])?.dir).toBe("flat");
    expect(trendDelta([5])).toBeNull();
  });
});

describe("fleetSnapshot / busiestServers", () => {
  const servers = [srv("a", "ONLINE"), srv("b", "ONLINE"), srv("c", "ONLINE"), srv("d", "OFFLINE"), srv("e", "ONLINE")];
  const metrics = [
    latest("a", 10, 20, 85),
    latest("b", 90, 60, 50),
    latest("c", 50, 40, 82, NOW - 120_000), // stale → ignored
    latest("d", 99), // offline → ignored
  ];
  const rows = buildFleetRows(servers, metrics, NOW); // "e" has no sample
  it("averages live servers only and counts disk pressure", () => {
    const snap = fleetSnapshot(rows);
    expect(snap.cpu).toBe(50);
    expect(snap.mem).toBe(40);
    expect(snap.diskKnown).toBe(true);
    expect(snap.diskPressure).toBe(1);
    expect(DISK_PRESSURE_PCT).toBe(80);
  });
  it("reports no data (hide the tiles) when nothing is live", () => {
    const snap = fleetSnapshot(buildFleetRows([srv("a", "ONLINE")], [], NOW));
    expect(snap).toEqual({ cpu: null, mem: null, diskKnown: false, diskPressure: 0 });
  });
  it("lists the top live servers by CPU, busiest first, capped", () => {
    expect(busiestServers(rows).map((r) => r.server.id)).toEqual(["b", "a"]);
    const many = Array.from({ length: 8 }, (_, i) => srv(`s${i}`, "ONLINE"));
    const m = many.map((s, i) => latest(s.id, i * 10));
    expect(busiestServers(buildFleetRows(many, m, NOW), 3).map((r) => r.server.id)).toEqual(["s7", "s6", "s5"]);
  });
});

describe("statusFromParam", () => {
  it("accepts only the exact server statuses", () => {
    expect(statusFromParam("OFFLINE")).toBe("OFFLINE");
    expect(statusFromParam("offline")).toBeNull();
    expect(statusFromParam(null)).toBeNull();
    expect(statusFromParam("junk")).toBeNull();
  });
});
