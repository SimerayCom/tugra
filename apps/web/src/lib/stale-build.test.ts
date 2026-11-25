import { afterEach, describe, expect, it, vi } from "vitest";
import { isStaleBuildError, reloadForNewBuild } from "./stale-build";

describe("stale build detection", () => {
  it("recognises chunk-load errors from webpack and native dynamic import", () => {
    const chunk = Object.assign(new Error("Loading chunk 4821 failed."), { name: "ChunkLoadError" });
    expect(isStaleBuildError(chunk)).toBe(true);
    expect(isStaleBuildError(new TypeError("Failed to fetch dynamically imported module: /_next/static/x.js"))).toBe(true);
    expect(isStaleBuildError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
  });

  describe("reloadForNewBuild", () => {
    const reload = vi.fn();
    afterEach(() => { sessionStorage.clear(); reload.mockReset(); vi.unstubAllGlobals(); });
    it("reloads once, then not again within a minute (no reload loop)", () => {
      vi.stubGlobal("location", { ...window.location, reload });
      expect(reloadForNewBuild(1_000_000)).toBe(true);
      expect(reloadForNewBuild(1_030_000)).toBe(false);
      expect(reloadForNewBuild(1_070_000)).toBe(true);
      expect(reload).toHaveBeenCalledTimes(2);
    });
  });
});
