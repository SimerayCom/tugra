import { describe, it, expect } from "vitest";
import { groupByTeam, statusCounts, writableIds, pct, formatUptime, fmtBytesStr } from "./fleet";
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
  hostname: null,
  os: null,
  osVersion: null,
  arch: null,
  kernel: null,
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
  role: canWrite ? "OWNER" : "VIEWER",
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
});
