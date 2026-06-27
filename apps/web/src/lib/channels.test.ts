import { describe, it, expect } from "vitest";
import { visibleChannels } from "./channels";
import type { Channel } from "./types";

const ch = (id: string, teamId: string): Channel => ({
  id, name: id, type: "webhook", teamId, enabled: true, eventTypes: [],
});

describe("visibleChannels", () => {
  const all = [ch("a", "t1"), ch("b", "t2"), ch("c", "t1")];

  it("scopes channels to the active team", () => {
    expect(visibleChannels(all, "t1").map((c) => c.id)).toEqual(["a", "c"]);
    expect(visibleChannels(all, "t2").map((c) => c.id)).toEqual(["b"]);
  });
  it("returns [] when no channel matches the team", () => {
    expect(visibleChannels(all, "t9")).toEqual([]);
  });
  it("returns all channels when no team is active", () => {
    expect(visibleChannels(all, "")).toEqual(all);
  });
});
