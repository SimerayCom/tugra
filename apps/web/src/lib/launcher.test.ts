import { describe, it, expect } from "vitest";
import { Box, GitBranch, Layers } from "lucide-react";
import { launcherTiles, launcherIcon, tileActions, tilePhase, deriveLinkKind } from "./launcher";
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

  it("derives phase and linkKind on each tile", () => {
    const [tunnel, ip] = launcherTiles([
      app({ id: "a", name: "a", url: "https://a.tunnel.io", status: "RUNNING", domain: "a.tunnel.io", tunnelExposed: true }),
      app({ id: "b", name: "b", url: "http://10.0.0.5:8080", status: "FAILED", domain: null, tunnelExposed: false }),
    ]);
    expect(tunnel).toMatchObject({ phase: "running", linkKind: "tunnel", tunnelExposed: true });
    expect(ip).toMatchObject({ phase: "failed", linkKind: "ip" });
  });
});

describe("tilePhase", () => {
  it("maps every AppStatus to a plain-language phase", () => {
    expect(tilePhase("RUNNING")).toBe("running");
    expect(tilePhase("STOPPED")).toBe("stopped");
    expect(tilePhase("FAILED")).toBe("failed");
    expect(tilePhase("NEW")).toBe("new");
  });
});

describe("deriveLinkKind", () => {
  it("none when there is no url", () => {
    expect(deriveLinkKind({ url: null, domain: null, tunnelExposed: false })).toBe("none");
    expect(deriveLinkKind({ url: null, domain: "x.io", tunnelExposed: true })).toBe("none");
  });
  it("tunnel wins over a plain domain", () => {
    expect(deriveLinkKind({ url: "https://x.io", domain: "x.io", tunnelExposed: true })).toBe("tunnel");
  });
  it("domain when a real hostname is set but not tunnelled", () => {
    expect(deriveLinkKind({ url: "https://x.io", domain: "x.io", tunnelExposed: false })).toBe("domain");
  });
  it("ip when the url is a bare address with no domain", () => {
    expect(deriveLinkKind({ url: "http://10.0.0.5:8080", domain: null, tunnelExposed: false })).toBe("ip");
  });
});

describe("tileActions", () => {
  it("offers open/restart/stop/expose/uninstall for a running app with a url", () => {
    expect(tileActions("RUNNING", true, true)).toEqual(["open", "restart", "stop", "expose", "uninstall"]);
  });

  it("offers start/expose/uninstall for a fresh domainless app", () => {
    expect(tileActions("NEW", false, true)).toEqual(["start", "expose", "uninstall"]);
  });

  it("offers open/start/expose/uninstall for a stopped app that has a domain", () => {
    expect(tileActions("STOPPED", true, true)).toEqual(["open", "start", "expose", "uninstall"]);
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
