import { describe, it, expect } from "vitest";
import { Box, GitBranch, Layers } from "lucide-react";
import { launcherTiles, launcherIcon, tileActions } from "./launcher";
import type { Application } from "./types";

const app = (over: Partial<Application>): Application =>
  ({ id: "x", name: "x", url: null, status: "RUNNING", source: "IMAGE", ...over } as Application);

describe("launcherTiles", () => {
  it("puts openable+running apps first, domainless apps last, sorted by name", () => {
    const apps = [
      app({ id: "d", name: "delta", url: null, status: "RUNNING" }), // no domain → last
      app({ id: "b", name: "bravo", url: "https://b.io", status: "STOPPED" }), // openable, not running
      app({ id: "a", name: "alpha", url: "https://a.io", status: "RUNNING" }), // openable+running → first
      app({ id: "c", name: "charlie", url: "https://c.io", status: "RUNNING" }), // openable+running
    ];
    expect(launcherTiles(apps).map((t) => t.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("passes url, status and template branding through and returns [] for no apps", () => {
    const [t] = launcherTiles([
      app({ id: "z", name: "z", url: "https://z.io", status: "FAILED", templateSlug: "n8n", templateLogo: "n8n" }),
    ]);
    expect(t).toMatchObject({ id: "z", url: "https://z.io", status: "FAILED", templateSlug: "n8n", templateLogo: "n8n" });
    expect(launcherTiles([])).toEqual([]);
  });
});

describe("tileActions", () => {
  it("offers open/restart/stop/uninstall for a running app with a url", () => {
    expect(tileActions("RUNNING", true, true)).toEqual(["open", "restart", "stop", "uninstall"]);
  });

  it("offers start/addDomain/uninstall for a fresh domainless app", () => {
    expect(tileActions("NEW", false, true)).toEqual(["start", "addDomain", "uninstall"]);
  });

  it("offers open/start/uninstall for a stopped app that has a domain", () => {
    expect(tileActions("STOPPED", true, true)).toEqual(["open", "start", "uninstall"]);
  });

  it("offers only 'open' to a viewer (no write actions)", () => {
    expect(tileActions("RUNNING", true, false)).toEqual(["open"]);
    expect(tileActions("NEW", false, false)).toEqual([]); // no url, no write → nothing
  });
});

describe("launcherIcon", () => {
  it("maps source to an icon", () => {
    expect(launcherIcon("IMAGE")).toBe(Box);
    expect(launcherIcon("GIT")).toBe(GitBranch);
    expect(launcherIcon("COMPOSE")).toBe(Layers);
  });
});
