import { describe, it, expect } from "vitest";
import { groupByTeam, statusCounts, writableIds, pct, formatUptime, fmtBytesStr, teamLabel, filterByStatus } from "./fleet";
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
  cleanupVolumes: false,
  lastCleanupAt: null,
  lastSeenAt: null,
  createdAt: new Date().toISOString(),
  seal: null,
  tags: [],
  capabilities: [],
  isLocal: false,
  provider: null,
  providerServerId: null,
  canWrite,
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
