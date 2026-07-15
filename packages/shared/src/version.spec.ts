import { appVersion, releaseChannel, gitSha, edition, versionInfo, PROTOCOL_VERSION } from "./version";

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
