import { describe, it, expect } from "vitest";
import { fleetAttention } from "./dashboard";
import type { ServerView, Monitor, DomainView } from "./types";

const srv = (id: string, status: ServerView["status"]): ServerView =>
  ({ id, name: `srv-${id}`, status } as ServerView);
const mon = (id: string, status: Monitor["status"]): Monitor =>
  ({ id, name: `mon-${id}`, status } as Monitor);
const dom = (domain: string, appId: string, state: DomainView["ssl"]["state"]): DomainView =>
  ({ domain, appId, ssl: { state } } as DomainView);

describe("fleetAttention", () => {
  it("collects offline servers, down monitors and bad SSL certs, ignoring healthy ones", () => {
    const servers = [srv("a", "ONLINE"), srv("b", "OFFLINE"), srv("c", "PENDING")];
    const monitors = [mon("x", "UP"), mon("y", "DOWN"), mon("z", "PENDING")];
    const domains = [dom("ok.io", "app1", "ok"), dom("exp.io", "app2", "expiring"), dom("bad.io", "app3", "error")];
    const out = fleetAttention(servers, monitors, domains);
    expect(out).toEqual([
      { kind: "server", id: "b", name: "srv-b", status: "OFFLINE" },
      { kind: "monitor", id: "y", name: "mon-y", status: "DOWN" },
      { kind: "domain", id: "app2", name: "exp.io", status: "expiring" }, // link → owning app
      { kind: "domain", id: "app3", name: "bad.io", status: "error" },
    ]);
  });

  it("returns [] when everything is healthy", () => {
    expect(fleetAttention([srv("a", "ONLINE")], [mon("x", "UP")], [dom("ok.io", "a", "ok")])).toEqual([]);
    expect(fleetAttention([], [])).toEqual([]);
  });
});
