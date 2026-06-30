import { describe, it, expect } from "vitest";
import { fleetAttention } from "./dashboard";
import type { ServerView, Monitor } from "./types";

const srv = (id: string, status: ServerView["status"]): ServerView =>
  ({ id, name: `srv-${id}`, status } as ServerView);
const mon = (id: string, status: Monitor["status"]): Monitor =>
  ({ id, name: `mon-${id}`, status } as Monitor);

describe("fleetAttention", () => {
  it("collects offline servers and down monitors, ignoring healthy ones", () => {
    const servers = [srv("a", "ONLINE"), srv("b", "OFFLINE"), srv("c", "PENDING")];
    const monitors = [mon("x", "UP"), mon("y", "DOWN"), mon("z", "PENDING")];
    const out = fleetAttention(servers, monitors);
    expect(out).toEqual([
      { kind: "server", id: "b", name: "srv-b", status: "OFFLINE" },
      { kind: "monitor", id: "y", name: "mon-y", status: "DOWN" },
    ]);
  });

  it("returns [] when everything is healthy", () => {
    expect(fleetAttention([srv("a", "ONLINE")], [mon("x", "UP")])).toEqual([]);
    expect(fleetAttention([], [])).toEqual([]);
  });
});
