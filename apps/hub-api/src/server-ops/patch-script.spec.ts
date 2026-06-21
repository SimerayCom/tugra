import {
  buildCheckScript,
  buildUpgradeAllScript,
  buildUpgradeOneScript,
  parseUpgradable,
} from "./patch-script";

describe("patch-script", () => {
  it("builds an apt-only check script with markers", () => {
    const s = buildCheckScript();
    expect(s).toContain("apt-get update");
    expect(s).toContain("apt list --upgradable");
    expect(s).toContain("TUGRA_UNSUPPORTED");
    expect(s).toContain("reboot-required");
  });

  it("builds upgrade scripts; rejects bad package names", () => {
    expect(buildUpgradeAllScript()).toContain("apt-get upgrade -y");
    expect(buildUpgradeOneScript("docker-ce")).toContain("--only-upgrade -y docker-ce");
    expect(() => buildUpgradeOneScript("evil; rm -rf /")).toThrow(/invalid/);
    expect(() => buildUpgradeOneScript("")).toThrow(/invalid/);
  });

  describe("parseUpgradable", () => {
    const sample = [
      "TUGRA_UPGRADABLE",
      "Listing...",
      "docker-ce/noble 5:29.6.0-1~noble amd64 [upgradable from: 5:29.5.0-1~noble]",
      "vim/noble-updates 2:9.1.0016-1ubuntu7.16 amd64 [upgradable from: 2:9.1.0016-1ubuntu7.15]",
      "",
    ].join("\n");

    it("parses upgradable packages (name/current/candidate)", () => {
      const r = parseUpgradable(sample);
      expect(r.supported).toBe(true);
      expect(r.count).toBe(2);
      expect(r.packages[0]).toEqual({ name: "docker-ce", candidate: "5:29.6.0-1~noble", current: "5:29.5.0-1~noble" });
      expect(r.packages[1].name).toBe("vim");
    });

    it("flags reboot-required", () => {
      expect(parseUpgradable(sample + "\nTUGRA_REBOOT").rebootRequired).toBe(true);
      expect(parseUpgradable(sample).rebootRequired).toBe(false);
    });

    it("reports unsupported distros", () => {
      const r = parseUpgradable("TUGRA_UNSUPPORTED");
      expect(r.supported).toBe(false);
      expect(r.count).toBe(0);
    });

    it("returns empty when nothing is upgradable", () => {
      expect(parseUpgradable("TUGRA_UPGRADABLE\nListing...\n").count).toBe(0);
    });
  });
});
