import { describe, it, expect } from "vitest";
import { groupByTeam, statusCounts, writableIds, pct } from "./fleet";
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
  lastSeenAt: null,
  createdAt: new Date().toISOString(),
  seal: null,
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
});
