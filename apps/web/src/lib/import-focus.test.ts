import { describe, it, expect, beforeEach } from "vitest";
import { IMPORT_FOCUS_KEY, focusSelection, focusSubject, lastImportUrl, parseImportFocus, rememberImportFocus, rememberLastImportUrl, takeImportFocus } from "./import-focus";
import type { ImportPlan } from "./types";

const plan = {
  items: [
    { itemRef: "app:srvA:a1", kind: "app" },
    { itemRef: "app:srvA:a2", kind: "app" },
    { itemRef: "database:srvB:d1", kind: "database" },
  ],
  preflight: {
    hosts: [{ ref: "srvA", name: "Box A" }, { ref: "srvB", name: "Box B" }],
    projects: [{ ref: "p1", name: "Shop", itemRefs: ["app:srvA:a1", "database:srvB:d1"] }],
  },
} as unknown as ImportPlan;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("import focus hand-over", () => {
  it("is read once and cleared", () => {
    rememberImportFocus({ kind: "coolify", address: "https://c.example.com", fromServerName: "Box" });
    expect(takeImportFocus()).toEqual({ kind: "coolify", address: "https://c.example.com", fromServerName: "Box" });
    expect(takeImportFocus()).toBeNull();
  });
  it("keeps only well-formed fields and never anything token-like", () => {
    expect(parseImportFocus(JSON.stringify({ kind: "evil", address: "javascript:alert(1)", token: "secret", sourceServerUuid: "u1" }))).toEqual({ sourceServerUuid: "u1" });
    expect(parseImportFocus("not json")).toBeNull();
    expect(parseImportFocus(null)).toBeNull();
    expect(window.sessionStorage.getItem(IMPORT_FOCUS_KEY)).toBeNull();
  });
  it("remembers the last panel address (an address only) and ignores junk", () => {
    expect(lastImportUrl("coolify")).toBeNull();
    rememberLastImportUrl("coolify", "https://c.example.com");
    rememberLastImportUrl("dokploy", "ftp://nope");
    expect(lastImportUrl("coolify")).toBe("https://c.example.com");
    expect(lastImportUrl("dokploy")).toBeNull();
  });
});

describe("focusSelection", () => {
  const writable = [{ id: "t1", teamId: "team1" }, { id: "t2", teamId: "team2" }];
  it("opens on the one source server, placed on the Tugra server it is connected as, and asks for the rest", () => {
    const sel = focusSelection(plan, { sourceServerUuid: "srvA", targetServerId: "t1", targetTeamId: "ignored" }, writable)!;
    expect(sel.mode).toBe("servers");
    expect([...sel.hosts]).toEqual(["srvA"]);
    expect(sel.placement).toEqual({ srvA: "t1" });
    expect(sel.teamId).toBe("team1"); // from the server itself
  });
  it("never invents a placement when the Tugra server is unknown, and leaves the destination to be picked", () => {
    const sel = focusSelection(plan, { sourceServerUuid: "srvB" }, writable)!;
    expect(sel.placement).toEqual({});
    expect(sel.teamId).toBeUndefined();
  });
  it("drops a connected server the user cannot write to (or does not see), and its team", () => {
    for (const w of [[], [{ id: "other", teamId: "team9" }]]) {
      const sel = focusSelection(plan, { sourceServerUuid: "srvA", targetServerId: "t1", targetTeamId: "team1" }, w)!;
      expect(sel.placement).toEqual({});
      expect(sel.teamId).toBeUndefined();
    }
  });
  it("opens on a project when only the project is known, placed only when it lives on one source server", () => {
    const sel = focusSelection(plan, { sourceProjectUuid: "p1", targetServerId: "t1" }, writable)!;
    expect(sel.mode).toBe("projects");
    expect([...sel.projects]).toEqual(["p1"]);
    expect(sel.placement).toEqual({}); // the project spans two source servers: no single target is implied
    expect(sel.teamId).toBeUndefined();
    const one = { items: [{ itemRef: "app:srvA:a1", kind: "app" }], preflight: { hosts: [{ ref: "srvA", name: "Box A" }], projects: [{ ref: "p1", name: "Shop", itemRefs: ["app:srvA:a1"] }] } } as unknown as ImportPlan;
    const placed = focusSelection(one, { sourceProjectUuid: "p1", targetServerId: "t2" }, writable)!;
    expect(placed.placement).toEqual({ srvA: "t2" });
    expect(placed.teamId).toBe("team2");
  });
  it("is null when the plan has nothing by that name", () => {
    expect(focusSelection(plan, { sourceServerUuid: "gone" }, writable)).toBeNull();
    expect(focusSelection(plan, null, writable)).toBeNull();
    expect(focusSelection(plan, { fromServerName: "x" }, writable)).toBeNull();
    expect(focusSelection(plan, { fromItemName: "web" }, writable)).toBeNull();
  });
});

describe("focusSubject", () => {
  it("names what the focus ticked", () => {
    const writable = [{ id: "t1", teamId: "team1" }];
    expect(focusSubject(plan, focusSelection(plan, { sourceServerUuid: "srvA" }, writable))).toEqual({ kind: "server", name: "Box A" });
    expect(focusSubject(plan, focusSelection(plan, { sourceProjectUuid: "p1" }, writable))).toEqual({ kind: "project", name: "Shop" });
    expect(focusSubject(plan, null)).toBeNull();
  });
  it("keeps the clicked item's name through storage", () => {
    expect(parseImportFocus(JSON.stringify({ sourceProjectUuid: "p1", fromItemName: "web" }))).toEqual({ sourceProjectUuid: "p1", fromItemName: "web" });
  });
});
