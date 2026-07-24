import {
  buildCheckScript,
  buildUpgradeAllScript,
  buildUpgradeOneScript,
  parseUpgradable,
} from "./patch-script";

describe("patch-script", () => {
  it("builds a check script that auto-detects apt / dnf / yum / apk", () => {
    const s = buildCheckScript();
    // apt
    expect(s).toContain("command -v apt-get");
    expect(s).toContain("apt list --upgradable");
    expect(s).toContain("reboot-required");
    // dnf / yum
    expect(s).toContain("command -v dnf");
    expect(s).toContain("dnf -q check-update");
    expect(s).toContain("command -v yum");
    expect(s).toContain("yum -q check-update");
    // apk
    expect(s).toContain("command -v apk");
    expect(s).toContain("apk version -l '<'");
    // markers
    expect(s).toContain("TUGRA_MGR=apt");
    expect(s).toContain("TUGRA_MGR=dnf");
    expect(s).toContain("TUGRA_MGR=apk");
    expect(s).toContain("TUGRA_UNSUPPORTED");
    // dnf/yum: wide COLUMNS stops long names wrapping, and a real check failure is flagged (not "up to date")
    expect(s).toContain("COLUMNS=1000 dnf -q check-update");
    expect(s).toContain("COLUMNS=1000 yum -q check-update");
    expect(s).toContain("TUGRA_CHECK_FAILED");
  });

  it("builds upgrade-all with every manager branch", () => {
    const s = buildUpgradeAllScript();
    expect(s).toContain("apt-get upgrade -y");
    expect(s).toContain("dnf -y upgrade");
    expect(s).toContain("yum -y update");
    expect(s).toContain("apk upgrade");
  });

  it("builds upgrade-one per manager; strictly validates the package name", () => {
    const s = buildUpgradeOneScript("docker-ce");
    expect(s).toContain("--only-upgrade -y docker-ce"); // apt
    expect(s).toContain("dnf -y upgrade docker-ce");
    expect(s).toContain("yum -y update docker-ce");
    expect(s).toContain("apk upgrade docker-ce");
    // dnf reports names with an arch suffix (curl.x86_64) — the dotted name is allowed
    expect(() => buildUpgradeOneScript("curl.x86_64")).not.toThrow();
    // injection / flags rejected
    expect(() => buildUpgradeOneScript("evil; rm -rf /")).toThrow(/invalid/);
    expect(() => buildUpgradeOneScript("--force")).toThrow(/invalid/);
    expect(() => buildUpgradeOneScript("a b")).toThrow(/invalid/);
    expect(() => buildUpgradeOneScript("")).toThrow(/invalid/);
  });

  describe("parseUpgradable", () => {
    it("apt: parses name/current/candidate + manager", () => {
      const out = [
        "TUGRA_MGR=apt",
        "TUGRA_UPGRADABLE",
        "Listing...",
        "docker-ce/noble 5:29.6.0-1~noble amd64 [upgradable from: 5:29.5.0-1~noble]",
        "vim/noble-updates 2:9.1.0016-1ubuntu7.16 amd64 [upgradable from: 2:9.1.0016-1ubuntu7.15]",
        "",
      ].join("\n");
      const r = parseUpgradable(out);
      expect(r.supported).toBe(true);
      expect(r.manager).toBe("apt");
      expect(r.count).toBe(2);
      expect(r.packages[0]).toEqual({ name: "docker-ce", candidate: "5:29.6.0-1~noble", current: "5:29.5.0-1~noble" });
      expect(r.packages[1].name).toBe("vim");
    });

    it("dnf: parses name.arch + candidate (current unknown from check-update)", () => {
      const out = [
        "TUGRA_MGR=dnf",
        "TUGRA_UPGRADABLE",
        "",
        "curl.x86_64                7.76.1-26.el9_3.2    baseos",
        "libcurl.x86_64             7.76.1-26.el9_3.2    baseos",
        "Last metadata expiration check: 0:00:12 ago on Wed.",
      ].join("\n");
      const r = parseUpgradable(out);
      expect(r.manager).toBe("dnf");
      expect(r.count).toBe(2); // the "Last metadata" noise line is not counted
      expect(r.packages[0]).toEqual({ name: "curl.x86_64", candidate: "7.76.1-26.el9_3.2", current: "" });
    });

    it("yum: same rpm format", () => {
      const r = parseUpgradable("TUGRA_MGR=yum\nTUGRA_UPGRADABLE\nkernel.x86_64  5.14.0-427  baseos\n");
      expect(r.manager).toBe("yum");
      expect(r.count).toBe(1);
      expect(r.packages[0].name).toBe("kernel.x86_64");
    });

    it("apk: parses name-current < candidate (handles hyphenated names)", () => {
      const out = [
        "TUGRA_MGR=apk",
        "TUGRA_UPGRADABLE",
        "zlib-1.2.13-r0 < 1.2.13-r1",
        "py3-foo-1.2-r0 < 1.3-r0",
      ].join("\n");
      const r = parseUpgradable(out);
      expect(r.manager).toBe("apk");
      expect(r.count).toBe(2);
      expect(r.packages[0]).toEqual({ name: "zlib", current: "1.2.13-r0", candidate: "1.2.13-r1" });
      expect(r.packages[1].name).toBe("py3-foo"); // hyphenated name kept intact
    });

    it("flags reboot-required", () => {
      const base = "TUGRA_MGR=apt\nTUGRA_UPGRADABLE\n";
      expect(parseUpgradable(base + "TUGRA_REBOOT").rebootRequired).toBe(true);
      expect(parseUpgradable(base).rebootRequired).toBe(false);
    });

    it("reports unsupported distros (no manager / explicit marker)", () => {
      expect(parseUpgradable("TUGRA_UNSUPPORTED").supported).toBe(false);
      expect(parseUpgradable("garbage output").supported).toBe(false); // no TUGRA_MGR → unsupported
    });

    it("returns empty when nothing is upgradable", () => {
      expect(parseUpgradable("TUGRA_MGR=apt\nTUGRA_UPGRADABLE\nListing...\n").count).toBe(0);
    });

    it("dnf: flags a failed check-update as checkFailed (NOT silently 'up to date')", () => {
      // repo unreachable / bad GPG → dnf errors, no package list, script emits TUGRA_CHECK_FAILED
      const r = parseUpgradable("TUGRA_MGR=dnf\nTUGRA_UPGRADABLE\nTUGRA_CHECK_FAILED\n");
      expect(r.supported).toBe(true);
      expect(r.checkFailed).toBe(true);
      expect(r.count).toBe(0);
    });

    it("a normal (successful) check is not flagged as failed", () => {
      expect(parseUpgradable("TUGRA_MGR=apt\nTUGRA_UPGRADABLE\n").checkFailed).toBe(false);
      expect(parseUpgradable("TUGRA_MGR=dnf\nTUGRA_UPGRADABLE\ncurl.x86_64  7.76.1  baseos\n").checkFailed).toBe(false);
    });

    it("dnf: does not turn the 'Obsoleting Packages' block into phantom upgrades", () => {
      const out = [
        "TUGRA_MGR=dnf",
        "TUGRA_UPGRADABLE",
        "curl.x86_64                7.76.1-26.el9_3.2    baseos",
        "",
        "Obsoleting Packages",
        "NetworkManager-adsl.x86_64    1:1.42.4-1.el9    baseos",
        "    NetworkManager-adsl.x86_64    1:1.40.0-1.el9    @System",
      ].join("\n");
      const r = parseUpgradable(out);
      // only the genuine upgradable line counts — the obsoletes block (incl. the @System installed row) is dropped
      expect(r.count).toBe(1);
      expect(r.packages[0].name).toBe("curl.x86_64");
      expect(r.packages.some((p) => p.candidate.includes("1.40.0"))).toBe(false);
    });

    it("dnf: skips already-installed (@System) rows even outside an obsoletes block", () => {
      const r = parseUpgradable("TUGRA_MGR=dnf\nTUGRA_UPGRADABLE\nkernel.x86_64  5.14.0-427  @System\ncurl.x86_64  7.76.1  baseos\n");
      expect(r.count).toBe(1);
      expect(r.packages[0].name).toBe("curl.x86_64");
    });
  });
});
