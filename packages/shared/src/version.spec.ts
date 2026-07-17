import {
  appVersion,
  releaseChannel,
  gitSha,
  edition,
  versionInfo,
  PROTOCOL_VERSION,
  parseVersion,
  compareVersions,
  isNewer,
} from "./version";

// @tugra/shared carries no @types/node — type `process` for the spec the same way version.ts does.
declare const process: { env: Record<string, string | undefined> };

describe("version", () => {
  const KEYS = ["TUGRA_VERSION", "TUGRA_CHANNEL", "GIT_SHA", "TUGRA_EDITION"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("falls back to dev defaults when the env is unset", () => {
    expect(appVersion()).toBe("0.0.0-dev");
    expect(releaseChannel()).toBe("dev");
    expect(gitSha()).toBe("");
    expect(edition()).toBe("community");
  });

  it("reads the injected build metadata from the env", () => {
    process.env.TUGRA_VERSION = "0.1.0";
    process.env.TUGRA_CHANNEL = "stable";
    process.env.GIT_SHA = "abc1234";
    process.env.TUGRA_EDITION = "pro";
    expect(appVersion()).toBe("0.1.0");
    expect(releaseChannel()).toBe("stable");
    expect(gitSha()).toBe("abc1234");
    expect(edition()).toBe("pro");
  });

  it("treats an empty-string env value as unset (falls back)", () => {
    process.env.TUGRA_VERSION = "";
    expect(appVersion()).toBe("0.0.0-dev");
  });

  it("versionInfo() returns the full descriptor with the protocol constant", () => {
    process.env.TUGRA_VERSION = "0.1.0";
    expect(versionInfo()).toEqual({ version: "0.1.0", protocol: PROTOCOL_VERSION, channel: "dev", commit: "", edition: "community" });
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

describe("semver comparator", () => {
  describe("parseVersion", () => {
    it("parses a plain x.y.z", () => {
      expect(parseVersion("1.2.3")).toEqual({ core: [1, 2, 3], pre: [] });
    });
    it("tolerates a leading v and surrounding whitespace", () => {
      expect(parseVersion("  v0.10.0 ")).toEqual({ core: [0, 10, 0], pre: [] });
    });
    it("captures pre-release identifiers", () => {
      expect(parseVersion("1.0.0-rc.1")).toEqual({ core: [1, 0, 0], pre: ["rc", "1"] });
      expect(parseVersion("0.0.0-dev")).toEqual({ core: [0, 0, 0], pre: ["dev"] });
    });
    it("drops +build metadata (SemVer precedence ignores it)", () => {
      expect(parseVersion("1.2.3+build.5")).toEqual({ core: [1, 2, 3], pre: [] });
      expect(parseVersion("1.2.3-rc.1+abc")).toEqual({ core: [1, 2, 3], pre: ["rc", "1"] });
    });
    it("rejects trailing garbage and non-versions (anchored) → null", () => {
      for (const bad of ["1.2", "1.2.3.4", "1.2.3 <script>", "latest", "", "x.y.z", "1.2.3-"]) {
        expect(parseVersion(bad)).toBeNull();
      }
      expect(parseVersion(undefined as unknown as string)).toBeNull();
    });
  });

  describe("compareVersions (two parsed)", () => {
    const P = (v: string) => parseVersion(v)!;
    it("orders by core major/minor/patch", () => {
      expect(compareVersions(P("1.0.0"), P("2.0.0"))).toBe(-1);
      expect(compareVersions(P("1.3.0"), P("1.2.9"))).toBe(1);
      expect(compareVersions(P("1.2.3"), P("1.2.4"))).toBe(-1);
      expect(compareVersions(P("1.2.3"), P("1.2.3"))).toBe(0);
    });
    it("ranks a release above a pre-release of the same core", () => {
      expect(compareVersions(P("1.0.0"), P("1.0.0-rc.1"))).toBe(1);
      expect(compareVersions(P("1.0.0-rc.1"), P("1.0.0"))).toBe(-1);
      expect(compareVersions(P("1.0.0-a"), P("1.0.0-b"))).toBe(0); // pre-detail not distinguished
    });
  });

  describe("isNewer (downgrade guard)", () => {
    it("is true only for a strictly newer candidate", () => {
      expect(isNewer("0.2.0", "0.1.0")).toBe(true);
      expect(isNewer("0.2.0", "0.0.0-dev")).toBe(true); // local dev < any real release
      expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    });
    it("is false for equal or older candidates (no downgrade)", () => {
      expect(isNewer("0.1.0", "0.1.0")).toBe(false);
      expect(isNewer("0.1.0", "0.2.0")).toBe(false); // older → never an update
      expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
    });
    it("is false (fail-safe) when either side is unparseable", () => {
      expect(isNewer("garbage", "0.1.0")).toBe(false);
      expect(isNewer("0.2.0", "not-a-version")).toBe(false);
      expect(isNewer("", "0.1.0")).toBe(false);
    });
  });
});
