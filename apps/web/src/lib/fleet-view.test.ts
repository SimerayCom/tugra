import { describe, it, expect } from "vitest";
import type { FleetLatestRow, MetricsSample, ServerView } from "./types";
import { buildFleetRows, sortFleetRows, matchesFleetSearch, metricTone, type FleetRow } from "./fleet-view";

const NOW = 1_700_000_000_000;

function srv(over: Partial<ServerView>): ServerView {
  return {
    id: "s1", name: "web-1", status: "ONLINE", teamId: "t1", clusterId: null, clusterName: null,
    hostname: "web-1.host", publicIp: "10.0.0.1", publicIpv6: null, uptimeSeconds: 1000,
    lastSeenAt: new Date(NOW - 5_000).toISOString(), agentVersion: "1.0", cpuCores: 4, memTotalBytes: "1024",
    tags: [], ...over,
  } as unknown as ServerView;
}

function sample(over: Partial<MetricsSample> = {}): MetricsSample {
  return { ts: NOW, cpu: 10, memUsed: 50, memTotal: 100, diskUsed: 40, diskTotal: 50, netRx: 1000, netTx: 500, diskRead: 0, diskWrite: 0, ...over };
}

const row = (f: Partial<FleetRow> & { server: ServerView }): FleetRow =>
  ({ sample: null, cpu: null, memPct: null, diskPct: null, net: null, stale: false, ...f });

describe("buildFleetRows", () => {
  it("joins each server with its sample by id and derives cpu/mem%/disk%/net", () => {
    const servers = [srv({ id: "a" }), srv({ id: "b" })];
    const metrics: FleetLatestRow[] = [{ serverId: "a", sample: sample({ cpu: 12.5, memUsed: 80, memTotal: 100, diskUsed: 45, diskTotal: 50, netRx: 1000, netTx: 500 }) }];
    const rows = buildFleetRows(servers, metrics, NOW);
    expect(rows[0].cpu).toBe(12.5);
    expect(rows[0].memPct).toBe(80);
    expect(rows[0].diskPct).toBe(90);
    expect(rows[0].net).toBe(1500);
    // server b has no sample → all metrics null
    expect(rows[1].sample).toBeNull();
    expect(rows[1].cpu).toBeNull();
    expect(rows[1].memPct).toBeNull();
  });

  it("guards divide-by-zero totals (memTotal/diskTotal 0 → null, not NaN)", () => {
    const rows = buildFleetRows([srv({ id: "a" })], [{ serverId: "a", sample: sample({ memTotal: 0, diskTotal: 0 }) }], NOW);
    expect(rows[0].memPct).toBeNull();
    expect(rows[0].diskPct).toBeNull();
  });

  it("flags a row stale when its latest SAMPLE is older than the window; no sample → not stale (shows —)", () => {
    const fresh = buildFleetRows([srv({ id: "a" })], [{ serverId: "a", sample: sample({ ts: NOW - 10_000 }) }], NOW);
    expect(fresh[0].stale).toBe(false);
    const stale = buildFleetRows([srv({ id: "a" })], [{ serverId: "a", sample: sample({ ts: NOW - 120_000 }) }], NOW);
    expect(stale[0].stale).toBe(true);
    // a server that never reported shows "—" cells, not greyed-live numbers, so it is not "stale"
    const noSample = buildFleetRows([srv({ id: "a" })], [], NOW);
    expect(noSample[0].stale).toBe(false);
    expect(noSample[0].cpu).toBeNull();
  });

  it("degrades a malformed sample to null instead of crashing (undefined/NaN/string fields)", () => {
    const bad = { ts: NOW, cpu: undefined, memUsed: NaN, memTotal: 100, diskUsed: 10, diskTotal: 0, netRx: "x", netTx: 5 } as unknown as MetricsSample;
    const rows = buildFleetRows([srv({ id: "a" })], [{ serverId: "a", sample: bad }], NOW);
    expect(rows[0].cpu).toBeNull();
    expect(rows[0].memPct).toBeNull(); // memUsed NaN
    expect(rows[0].diskPct).toBeNull(); // diskTotal 0
    expect(rows[0].net).toBeNull(); // netRx not a number
  });

  it("tolerates a non-array metrics payload", () => {
    const rows = buildFleetRows([srv({ id: "a" })], null as unknown as never, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].cpu).toBeNull();
  });
});

describe("sortFleetRows", () => {
  const rows: FleetRow[] = [
    row({ server: srv({ id: "a", name: "alpha", uptimeSeconds: 300 }), cpu: 20 }),
    row({ server: srv({ id: "b", name: "bravo", uptimeSeconds: 100 }), cpu: 90 }),
    row({ server: srv({ id: "c", name: "charlie", uptimeSeconds: 200 }), cpu: null }), // no sample
  ];

  it("sorts a numeric column desc with no-sample rows always last", () => {
    const out = sortFleetRows(rows, "cpu", "desc");
    expect(out.map((r) => r.server.id)).toEqual(["b", "a", "c"]); // 90, 20, null
  });

  it("keeps no-sample rows last even ascending", () => {
    const out = sortFleetRows(rows, "cpu", "asc");
    expect(out.map((r) => r.server.id)).toEqual(["a", "b", "c"]); // 20, 90, null-last
  });

  it("sorts by name alphabetically", () => {
    expect(sortFleetRows(rows, "name", "asc").map((r) => r.server.name)).toEqual(["alpha", "bravo", "charlie"]);
    expect(sortFleetRows(rows, "name", "desc").map((r) => r.server.name)).toEqual(["charlie", "bravo", "alpha"]);
  });

  it("does not mutate the input array", () => {
    const before = rows.map((r) => r.server.id);
    sortFleetRows(rows, "cpu", "desc");
    expect(rows.map((r) => r.server.id)).toEqual(before);
  });

  it("treats a non-finite numeric value as null and sinks it to the bottom", () => {
    const rs = [
      row({ server: srv({ id: "a", name: "aa" }), cpu: 10 }),
      row({ server: srv({ id: "b", name: "bb" }), cpu: NaN as unknown as number }),
    ];
    expect(sortFleetRows(rs, "cpu", "desc").map((r) => r.server.id)).toEqual(["a", "b"]);
    expect(sortFleetRows(rs, "cpu", "asc").map((r) => r.server.id)).toEqual(["a", "b"]);
  });
});

describe("matchesFleetSearch", () => {
  const r = row({ server: srv({ name: "web-1", hostname: "web-1.fra.host", publicIp: "203.0.113.9" }) });
  it("matches name, hostname and IP case-insensitively; empty query matches all", () => {
    expect(matchesFleetSearch(r, "")).toBe(true);
    expect(matchesFleetSearch(r, "WEB")).toBe(true);
    expect(matchesFleetSearch(r, "fra")).toBe(true);
    expect(matchesFleetSearch(r, "203.0")).toBe(true);
    expect(matchesFleetSearch(r, "nope")).toBe(false);
  });
});

describe("metricTone", () => {
  it("is amber at 80 and red at 90", () => {
    expect(metricTone(10)).toBe("ok");
    expect(metricTone(79.9)).toBe("ok");
    expect(metricTone(80)).toBe("warn");
    expect(metricTone(89.9)).toBe("warn");
    expect(metricTone(90)).toBe("crit");
    expect(metricTone(null)).toBe("ok");
  });
});
