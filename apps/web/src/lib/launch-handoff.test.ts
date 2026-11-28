import { describe, it, expect } from "vitest";
import { LAUNCH_HANDOFF_KEY, launchPageHref, loadLaunchHandoff, saveLaunchHandoff, type LaunchHandoff } from "./launch-handoff";
import type { ImportScope } from "./import-scope";

const mem = () => {
  const m = new Map<string, string>();
  return { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
};
const scope: ImportScope = {
  selection: { mode: "servers", hosts: new Set(["h1", "h2"]), projects: new Set(), extra: new Set(["app:h1:x"]), placement: { h1: "srv1", h2: "srv2" } },
  inScope: new Set(["app:h1:web", "app:h2:api"]),
  narrowed: true,
  defaultServerId: "srv1",
  serverMap: undefined,
  placed: { h1: "srv1", h2: "srv2" },
  placementKind: { h1: "in-place", h2: "in-place" },
};
const h: LaunchHandoff = { kind: "coolify", sessionId: "session-abc12345", planHash: "a".repeat(32), extras: { acks: [{ code: "app.env.unresolved", itemRef: "app:h1:web" }], dbDataModes: { "database:h1:pg": "volume" } }, scope };

describe("launch handoff", () => {
  it("round-trips the scope, the acknowledgements and the plan hash", () => {
    const s = mem();
    expect(saveLaunchHandoff(h, s)).toBe(true);
    const back = loadLaunchHandoff(s);
    expect(back?.sessionId).toBe(h.sessionId);
    expect(back?.planHash).toBe(h.planHash);
    expect(back?.extras).toEqual(h.extras);
    expect([...(back?.scope?.inScope ?? [])].sort()).toEqual(["app:h1:web", "app:h2:api"]);
    expect(back?.scope).toMatchObject({ narrowed: true, defaultServerId: "srv1", placed: { h1: "srv1", h2: "srv2" }, placementKind: { h1: "in-place", h2: "in-place" } });
    expect([...(back?.scope?.selection.hosts ?? [])]).toEqual(["h1", "h2"]);
  });
  it("keeps a move without a first-step scope as null", () => {
    const s = mem();
    saveLaunchHandoff({ ...h, scope: null }, s);
    expect(loadLaunchHandoff(s)?.scope).toBeNull();
  });
  it("refuses a bad session id, and a tampered or unreadable record", () => {
    const s = mem();
    expect(saveLaunchHandoff({ ...h, sessionId: "x y" }, s)).toBe(false);
    s.setItem(LAUNCH_HANDOFF_KEY, "{nope");
    expect(loadLaunchHandoff(s)).toBeNull();
    s.setItem(LAUNCH_HANDOFF_KEY, JSON.stringify({ v: 1, kind: "coolify", sessionId: "session-abc12345", planHash: "a".repeat(32), scope: { selection: "x", inScope: [] } }));
    expect(loadLaunchHandoff(s)).toBeNull();
  });
  it("puts the session in the address", () => {
    expect(launchPageHref("session-abc12345")).toBe("/import/guided/new?s=session-abc12345");
  });
});
