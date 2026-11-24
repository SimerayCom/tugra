import { describe, it, expect } from "vitest";
import { clusterByTeam, relativeTime, secondsSince, serverLiveness, groupByTeam, statusCounts, writableIds, pct, formatUptime, fmtBytesStr, teamLabel, filterByStatus } from "./fleet";
import type { ServerView } from "./types";

const s = (
  id: string,
  teamId: string,
  canWrite: boolean,
  status: ServerView["status"] = "ONLINE",
): ServerView => ({
  id,
  name: id,
  status,
  teamId,
  clusterId: null,
  clusterName: null,
  hostname: null,
  publicIp: null,
  publicIpv6: null,
  ipSource: "observed",
  wildcardDomain: null,
  magicSuffix: null,
  certMode: "http",
  dnsProvider: null,
  customCertResolver: null,
  hasDnsCreds: false,
  os: null,
  osVersion: null,
  arch: null,
  kernel: null,
  agentVersion: null,
  cpuCores: null,
  memTotalBytes: null,
  uptimeSeconds: null,
  cleanupEnabled: false,
  cleanupIntervalHours: null,
  cleanupCron: null,
  cleanupThresholdPct: null,
  cleanupVolumes: false,
  description: null,
  timezone: null,
  lastCleanupAt: null,
  lastSeenAt: null,
  createdAt: new Date().toISOString(),
  seal: null,
  tags: [],
  capabilities: [],
  isLocal: false,
  proxyBind: "public",
  trafficAnalytics: false,
  provider: null,
  providerServerId: null,
  providerManualLink: false,
  canWrite,
  canOps: canWrite,
});

describe("fleet helpers", () => {
  it("groups servers by team (cross-team view)", () => {
    const g = groupByTeam([s("a", "t1", true), s("b", "t2", false), s("c", "t1", true)]);
    expect(Object.keys(g).sort()).toEqual(["t1", "t2"]);
    expect(g.t1.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("bulk selection only includes writable servers (role gating)", () => {
    const servers = [s("a", "t1", true), s("b", "t2", false), s("c", "t1", true)];
    const selected = new Set(["a", "b", "c"]);
    expect(writableIds(servers, selected).sort()).toEqual(["a", "c"]);
  });

  it("writableIds is generic over any {id, canWrite} (e.g. databases)", () => {
    const dbs = [
      { id: "d1", canWrite: true },
      { id: "d2", canWrite: false },
      { id: "d3", canWrite: true },
    ];
    expect(writableIds(dbs, new Set(["d1", "d2", "d3"]))).toEqual(["d1", "d3"]);
  });

  it("counts statuses", () => {
    const counts = statusCounts([
      s("a", "t", true, "ONLINE"),
      s("b", "t", true, "OFFLINE"),
      s("c", "t", true, "ONLINE"),
    ]);
    expect(counts.ONLINE).toBe(2);
    expect(counts.OFFLINE).toBe(1);
  });

  it("computes percentage safely", () => {
    expect(pct(50, 200)).toBe(25);
    expect(pct(1, 0)).toBe(0);
  });

  it("formats uptime compactly", () => {
    expect(formatUptime(null)).toBe("—");
    expect(formatUptime(90061)).toBe("1d 1h"); // 1 day 1 hour 1 min
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(120)).toBe("2m");
  });

  it("formats byte strings from the API", () => {
    expect(fmtBytesStr(null)).toBe("—");
    expect(fmtBytesStr(String(1 << 30))).toBe("1.0 GB");
  });

  it("resolves a team label with a short-id fallback", () => {
    const teams = [{ id: "team-abc123", name: "Acme Production" }];
    expect(teamLabel(teams, "team-abc123")).toBe("Acme Production");
    expect(teamLabel(teams, "unknown99")).toBe("unknow");
  });

  it("filters the fleet by status (null = all)", () => {
    const servers = [s("a", "t", true, "ONLINE"), s("b", "t", true, "OFFLINE"), s("c", "t", true, "ONLINE")];
    expect(filterByStatus(servers, null)).toHaveLength(3);
    expect(filterByStatus(servers, "ONLINE").map((x) => x.id)).toEqual(["a", "c"]);
    expect(filterByStatus(servers, "PENDING")).toEqual([]);
  });
});

describe("relativeTime / skew", () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  const ago = (s: number) => new Date(now - s * 1000).toISOString();

  it("never goes negative: a timestamp slightly in the browser's future reads 'just now'", () => {
    expect(secondsSince(new Date(now + 3000).toISOString(), now)).toBe(0);
    expect(relativeTime(new Date(now + 3000).toISOString(), undefined, now)).toBe("just now");
    expect(relativeTime(new Date(now + 3_600_000).toISOString(), undefined, now)).toBe("just now");
  });
  it("formats seconds, minutes, hours and days", () => {
    expect(relativeTime(ago(2), undefined, now)).toBe("just now");
    expect(relativeTime(ago(30), undefined, now)).toBe("30s ago");
    expect(relativeTime(ago(5 * 60), undefined, now)).toBe("5m ago");
    expect(relativeTime(ago(3 * 3600), undefined, now)).toBe("3h ago");
    expect(relativeTime(ago(2 * 86400), undefined, now)).toBe("2d ago");
  });
  it("uses the caller's translator and tolerates null / junk", () => {
    expect(relativeTime(ago(30), (k, v) => `${k}:${v?.n ?? ""}`, now)).toBe("common.time.secondsAgo:30");
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime("garbage")).toBe("—");
  });
});

describe("serverLiveness", () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  it("maps status and quiet-online to a dot state", () => {
    expect(serverLiveness("PENDING", null, now)).toBe("pending");
    expect(serverLiveness("OFFLINE", new Date(now).toISOString(), now)).toBe("offline");
    expect(serverLiveness("ONLINE", new Date(now - 10_000).toISOString(), now)).toBe("online");
    expect(serverLiveness("ONLINE", new Date(now - 200_000).toISOString(), now)).toBe("stale");
    expect(serverLiveness("ONLINE", null, now)).toBe("online");
  });
});

describe("clusterByTeam", () => {
  const sv = (id: string, teamId: string) => ({ id, teamId }) as unknown as ServerView;
  it("groups by team name and keeps the incoming order within a team", () => {
    const teams = [{ id: "t1", name: "Zeta" }, { id: "t2", name: "Acme" }];
    const out = clusterByTeam([sv("a", "t1"), sv("b", "t2"), sv("c", "t1"), sv("d", "t2")], teams);
    expect(out.map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
});
