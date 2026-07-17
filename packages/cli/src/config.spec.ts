import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig, setProfile, getActiveProfile, removeProfile, setCurrent, configPath } from "./config";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugra-cli-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

describe("config", () => {
  it("returns an empty config when none exists", () => {
    expect(loadConfig()).toEqual({ current: null, profiles: {} });
    expect(getActiveProfile()).toBeNull();
  });

  it("round-trips a profile and marks it active", () => {
    setProfile("prod", { hub: "https://h", token: "tugra_pat_x" });
    expect(getActiveProfile()).toEqual({ name: "prod", profile: { hub: "https://h", token: "tugra_pat_x" } });
    // survives a reload
    expect(loadConfig().profiles.prod.hub).toBe("https://h");
  });

  it("writes the config file with owner-only (0600) permissions", () => {
    setProfile("a", { hub: "https://h", token: "tugra_pat_secret" });
    if (process.platform !== "win32") {
      expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("supports multiple profiles and switching the active one", () => {
    setProfile("a", { hub: "https://a", token: "ta" });
    setProfile("b", { hub: "https://b", token: "tb" }); // b becomes active
    expect(getActiveProfile()?.name).toBe("b");
    setCurrent("a");
    expect(getActiveProfile()?.name).toBe("a");
  });

  it("clears the active pointer when the active profile is removed", () => {
    setProfile("a", { hub: "https://a", token: "ta" });
    expect(removeProfile("a")).toBe(true);
    expect(getActiveProfile()).toBeNull();
    expect(removeProfile("nope")).toBe(false);
  });

  it("setCurrent throws for an unknown profile", () => {
    expect(() => setCurrent("ghost")).toThrow(/no such profile/);
  });

  it("recovers from a corrupt config file", () => {
    fs.mkdirSync(dir + "/tugra", { recursive: true });
    fs.writeFileSync(configPath(), "{ not json");
    expect(loadConfig()).toEqual({ current: null, profiles: {} });
  });
});
