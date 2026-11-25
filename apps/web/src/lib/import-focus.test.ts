import { describe, it, expect, beforeEach } from "vitest";
import { IMPORT_FOCUS_KEY, focusSelection, lastImportUrl, parseImportFocus, rememberImportFocus, rememberLastImportUrl, takeImportFocus } from "./import-focus";
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
  it("opens on the one source server, placed on the Tugra server it is connected as", () => {
    const sel = focusSelection(plan, { sourceServerUuid: "srvA", targetServerId: "t1", targetTeamId: "team1" })!;
    expect(sel.mode).toBe("servers");
    expect([...sel.hosts]).toEqual(["srvA"]);
    expect(sel.placement).toEqual({ srvA: "t1" });
    expect(sel.teamId).toBe("team1");
  });
  it("never invents a placement when the Tugra server is unknown", () => {
    expect(focusSelection(plan, { sourceServerUuid: "srvB" })!.placement).toEqual({});
  });
  it("opens on a project when only the project is known", () => {
    const sel = focusSelection(plan, { sourceProjectUuid: "p1", targetServerId: "t1" })!;
    expect(sel.mode).toBe("projects");
    expect([...sel.projects]).toEqual(["p1"]);
    expect(sel.placement).toEqual({}); // the project spans two source servers: no single target is implied
  });
  it("is null when the plan has nothing by that name", () => {
    expect(focusSelection(plan, { sourceServerUuid: "gone" })).toBeNull();
    expect(focusSelection(plan, null)).toBeNull();
    expect(focusSelection(plan, { fromServerName: "x" })).toBeNull();
  });
});
