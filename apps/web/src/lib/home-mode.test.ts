import { describe, it, expect } from "vitest";
import {
  applyOrder, assignToFolder, backupSummary, countLabel, folderOf, groupTilesByFolder, groupTilesByTeam, homeScale, modeSwitchBody, modeSwitchImpact,
  moveBefore, moveBy, pickGaugeServer, serverStatusSummary, storageSummary, suggestFleet, uptimeParts,
} from "./home-mode";
import type { LauncherTile } from "./launcher";
import { translate } from "../i18n/translate";
import en from "../i18n/locales/en";

const t = (k: string, v?: Record<string, string | number>) => translate(en as never, k, v);

const tile = (id: string, over: Partial<LauncherTile> = {}): LauncherTile => ({
  id, name: id, url: null, status: "RUNNING", phase: "running", linkKind: "none", source: "IMAGE", templateSlug: null, templateLogo: null,
  iconUpdatedAt: null, exposeMode: "magic", domain: null, tunnelExposed: false, canWrite: true, teamId: "t1", projectId: null, projectName: null, serverId: "s1", ...over,
});
const servers = (n: number, teams = 1) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, teamId: `t${i % teams}`, status: "ONLINE" as const, isLocal: i === 0 }));
const teamList = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
const apps = (n: number, teams = 1) => Array.from({ length: n }, (_, i) => ({ teamId: `t${i % teams}` }));

describe("homeScale / suggestFleet scenarios", () => {
  it.each([
    // servers, teams, apps, expected suggestion
    [1, 1, 0, false],
    [1, 1, 100, false],
    [5, 1, 0, true],
    [5, 1, 100, true],
    [30, 8, 100, true],
    [1, 8, 100, true],
    [30, 1, 0, true],
  ])("%i servers / %i teams / %i apps -> suggest fleet %s", (s, tm, a, expected) => {
    const scale = homeScale(servers(s, tm), teamList(tm), apps(a, tm));
    expect(scale).toEqual({ servers: s, teams: tm, apps: a });
    expect(suggestFleet(scale)).toBe(expected);
  });

  it("falls back to the distinct teams seen on servers/apps while the team list is empty", () => {
    expect(homeScale(servers(3, 3), [], apps(0)).teams).toBe(3);
  });
});

describe("modeSwitchImpact", () => {
  it("is not risky for a single box, nor for the move to Fleet", () => {
    expect(modeSwitchImpact("home", { servers: 1, teams: 1, apps: 9 }).risky).toBe(false);
    expect(modeSwitchImpact("fleet", { servers: 30, teams: 8, apps: 100 }).risky).toBe(false);
  });
  it("is risky to Home with several servers or teams, and says what hides", () => {
    expect(modeSwitchImpact("home", { servers: 2, teams: 1, apps: 0 })).toEqual({ risky: true, hidden: ["servers"] });
    expect(modeSwitchImpact("home", { servers: 27, teams: 8, apps: 78 })).toEqual({ risky: true, hidden: ["servers", "teams"] });
  });
  it("spells the user's own counts into the confirmation copy", () => {
    expect(modeSwitchBody(t, { servers: 27, teams: 8, apps: 78 })).toContain("27 servers and 8 teams");
    expect(modeSwitchBody(t, { servers: 2, teams: 1, apps: 0 })).toBe("You have 2 servers. Home mode shows only this machine and hides the Servers page.");
    expect(countLabel(t, "home.count_servers", 1)).toBe("1 server");
  });
});

describe("groupTilesByTeam", () => {
  it("groups by team then project, names sorted, project-less last, one tile list preserved", () => {
    const tiles = [
      tile("a", { teamId: "t2", projectId: "p9", projectName: "Zeta" }),
      tile("b", { teamId: "t1", projectId: null, projectName: null }),
      tile("c", { teamId: "t1", projectId: "p1", projectName: "Alpha" }),
      tile("d", { teamId: "t1", projectId: "p1", projectName: "Alpha" }),
    ];
    const g = groupTilesByTeam(tiles, { t1: "Acme", t2: "Beta Co" });
    expect(g.map((x) => x.teamName)).toEqual(["Acme", "Beta Co"]);
    expect(g[0].projects.map((p) => p.name)).toEqual(["Alpha", null]);
    expect(g[0].projects[0].tiles.map((x) => x.id)).toEqual(["c", "d"]);
    expect(g.flatMap((x) => x.projects.flatMap((p) => p.tiles)).length).toBe(4);
  });
  it("uses the fallback name for a team the user cannot name", () => {
    expect(groupTilesByTeam([tile("a", { teamId: "tx" })], {}, "Other team")[0].teamName).toBe("Other team");
  });
  it("handles 8 teams x 100 apps without losing or duplicating tiles, and 0 apps", () => {
    const names = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`t${i}`, `Team ${i}`]));
    const tiles = Array.from({ length: 100 }, (_, i) => tile(`a${i}`, { teamId: `t${i % 8}`, projectId: `p${i % 3}`, projectName: `P${i % 3}` }));
    const g = groupTilesByTeam(tiles, names);
    expect(g).toHaveLength(8);
    const ids = g.flatMap((x) => x.projects.flatMap((p) => p.tiles.map((y) => y.id)));
    expect(new Set(ids).size).toBe(100);
    expect(groupTilesByTeam([], names)).toEqual([]);
  });
});

describe("order helpers", () => {
  const ids = ["a", "b", "c", "d"];
  it("moveBefore: forward drop lands after the target, backward before it", () => {
    expect(moveBefore(ids, "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveBefore(ids, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });
  it("moveBefore ignores unknown ids and self-drops", () => {
    expect(moveBefore(ids, "a", "a")).toBe(ids);
    expect(moveBefore(ids, "x", "a")).toBe(ids);
  });
  it("moveBy shifts one slot and clamps at the ends", () => {
    expect(moveBy(ids, "b", -1)).toEqual(["b", "a", "c", "d"]);
    expect(moveBy(ids, "a", -1)).toBe(ids);
    expect(moveBy(ids, "d", 1)).toBe(ids);
  });
  it("applyOrder puts known ids first, keeps the rest in place, ignores stale ids", () => {
    const tiles = ["a", "b", "c"].map((i) => tile(i));
    expect(applyOrder(tiles, ["c", "gone", "a"]).map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(applyOrder(tiles, [])).toBe(tiles);
  });
});

describe("folders", () => {
  const f = [{ id: "f1", name: "Media", tileIds: ["a", "ghost"] }, { id: "f2", name: "Tools", tileIds: [] }];
  it("assignToFolder keeps a tile in at most one folder and can unfile it", () => {
    const moved = assignToFolder(f, "a", "f2");
    expect(folderOf(moved, "a")).toBe("f2");
    expect(moved[0].tileIds).not.toContain("a");
    expect(folderOf(assignToFolder(moved, "a", null), "a")).toBeNull();
  });
  it("groupTilesByFolder drops stale ids, keeps empty folders, and adds an unfiled bucket only when needed", () => {
    const tiles = ["a", "b"].map((i) => tile(i));
    const g = groupTilesByFolder(tiles, f);
    expect(g.map((x) => [x.key, x.tiles.map((y) => y.id)])).toEqual([["f1", ["a"]], ["f2", []], ["__rest__", ["b"]]]);
    expect(groupTilesByFolder([tile("a")], [f[0]]).map((x) => x.key)).toEqual(["f1"]);
    expect(groupTilesByFolder([], [])).toEqual([{ key: "__rest__", folder: null, tiles: [] }]);
  });
});

describe("widgets", () => {
  it("summarises server status across 1 / 5 / 30 servers", () => {
    const mk = (n: number, offline = 0) => Array.from({ length: n }, (_, i) => ({ status: i < offline ? ("OFFLINE" as const) : ("ONLINE" as const) }));
    expect(serverStatusSummary(mk(1))).toEqual({ total: 1, online: 1, offline: 0, pending: 0 });
    expect(serverStatusSummary(mk(5, 2))).toMatchObject({ total: 5, online: 3, offline: 2 });
    expect(serverStatusSummary([...mk(29), { status: "PENDING" as const }])).toMatchObject({ total: 30, online: 29, pending: 1 });
    expect(serverStatusSummary([])).toEqual({ total: 0, online: 0, offline: 0, pending: 0 });
  });
  it("storage is null without data and clamps the percentage", () => {
    expect(storageSummary(undefined)).toBeNull();
    expect(storageSummary({ diskUsed: 1, diskTotal: 0 })).toBeNull();
    expect(storageSummary({ diskUsed: 50, diskTotal: 200 })?.pct).toBe(25);
    expect(storageSummary({ diskUsed: 300, diskTotal: 200 })?.pct).toBe(100);
    expect(storageSummary({ diskUsed: Number.NaN, diskTotal: 200 })).toBeNull();
  });
  it("backups count only databases that can be backed up", () => {
    expect(backupSummary([])).toEqual({ total: 0, protected: 0, unprotected: 0 });
    expect(backupSummary([{ backupSupported: true, backupEnabled: true }, { backupSupported: true, backupEnabled: false }, { backupSupported: false, backupEnabled: false }])).toEqual({ total: 2, protected: 1, unprotected: 1 });
  });
  it("uptime parts", () => {
    expect(uptimeParts(null)).toBeNull();
    expect(uptimeParts(-5)).toBeNull();
    expect(uptimeParts(90_000)).toEqual({ days: 1, hours: 1, minutes: 0 });
    expect(uptimeParts(125)).toEqual({ days: 0, hours: 0, minutes: 2 });
  });
});

describe("pickGaugeServer", () => {
  const list = servers(30);
  it("honors a valid pick, else the local box, else first online, else first", () => {
    expect(pickGaugeServer(list, "s7")?.id).toBe("s7");
    expect(pickGaugeServer(list, "gone")?.id).toBe("s0"); // local
    const noLocal = list.map((s) => ({ ...s, isLocal: false, status: s.id === "s3" ? ("ONLINE" as const) : ("OFFLINE" as const) }));
    expect(pickGaugeServer(noLocal, null)?.id).toBe("s3");
    expect(pickGaugeServer(noLocal.map((s) => ({ ...s, status: "OFFLINE" as const })), null)?.id).toBe("s0");
    expect(pickGaugeServer([], null)).toBeNull();
  });
});
