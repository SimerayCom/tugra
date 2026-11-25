import {
  buildCheckScript,
  isContainerEnginePackage,
  buildUpgradeAllScript,
  buildUpgradeOneScript,
  buildInstallPhasedScript,
  parsePhasedNames,
  wrapHostExec,
  buildPatchRunScript,
  parseHostExec,
  parsePatchRun,
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
    expect(s).toContain("apt-get -o Dpkg::Options::=--force-confold upgrade -y");
    expect(s).toContain("dnf -y upgrade");
    expect(s).toContain("yum -y update");
    expect(s).toContain("apk upgrade");
  });

  it("the apply finishes an interrupted dpkg itself — announced, gated on a real broken state, before the apt upgrade", () => {
    const all = buildUpgradeAllScript();
    const one = buildUpgradeOneScript("openssl");
    for (const s of [all, one]) {
      expect(s).toContain("dpkg --configure -a");
      // announced first (it may restart the container engine), and only when dpkg really has something to finish
      expect(s).toContain("TUGRA_WARN: dpkg was interrupted");
      expect(s).toContain("container engine");
      expect(s).toContain('if [ -n "$BROKEN" ]; then');
      expect(s.indexOf("TUGRA_WARN")).toBeLessThan(s.indexOf("dpkg --configure -a"));
      // the heal runs BEFORE the apt upgrade/install, and never aborts it (|| true)
      expect(s.indexOf("dpkg --configure -a")).toBeLessThan(s.indexOf("apt-get -o Dpkg"));
      expect(s).toMatch(/dpkg --configure -a 2>&1 \|\| true/);
    }
    // dnf/yum/apk branches are untouched (no dpkg heal spliced into them)
    expect(all.split("dnf -y upgrade")[1] ?? "").not.toContain("dpkg");
  });

  describe("a CHECK is read-only", () => {
    it("never configures, installs or upgrades anything", () => {
      const s = buildCheckScript();
      expect(s).not.toMatch(/dpkg\s+(--configure|-i|--install|--remove|-r|-P)/);
      // apt may only SIMULATE (-s) an upgrade (to read which packages Ubuntu defers for phasing) — never perform one
      expect(s).not.toMatch(/apt(-get)?\s+(-(?!s\b)\S+\s+)*(install|upgrade|dist-upgrade|full-upgrade|remove|purge|--fix-broken)/);
      for (const m of s.matchAll(/apt-get\s+(\S*\s+)*?(upgrade|dist-upgrade|full-upgrade)/g)) expect(m[0]).toMatch(/\s-s\s/);
      expect(s).not.toMatch(/dnf\s+(-y\s+)?(upgrade|install)|yum\s+(-y\s+)?(update|install)|apk\s+(upgrade|add)/);
      expect(s).not.toContain("--configure");
      // it only LOOKS at dpkg's state
      expect(s).toContain("dpkg-query -W");
      expect(s).toContain("TUGRA_DPKG_BROKEN=");
    });

    it("is the only place the check/apply split is observable: the apply scripts DO contain the heal, the check does not", () => {
      expect(buildCheckScript()).not.toContain("dpkg --configure");
      expect(buildUpgradeAllScript()).toContain("dpkg --configure -a");
    });
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
    // apt reads a trailing `-` as "remove this package" (a name that would turn an upgrade into a removal)
    expect(() => buildUpgradeOneScript("nginx-")).toThrow(/invalid/);
    expect(() => buildInstallPhasedScript("docker-ce-")).toThrow(/invalid/);
    expect(() => buildUpgradeOneScript("g++")).not.toThrow();
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
      expect(r.packages[0]).toEqual({ name: "docker-ce", group: "engine", candidate: "5:29.6.0-1~noble", current: "5:29.5.0-1~noble" });
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
      expect(r.packages[0]).toEqual({ name: "curl.x86_64", group: "other", candidate: "7.76.1-26.el9_3.2", current: "" });
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
      expect(r.packages[0]).toEqual({ name: "zlib", group: "other", current: "1.2.13-r0", candidate: "1.2.13-r1" });
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

  describe("apt hardening", () => {
    it("the apt upgrade lines suspend needrestart and keep the running config on conffile conflicts", () => {
      for (const s of [buildUpgradeAllScript(), buildUpgradeOneScript("openssl")]) {
        expect(s).toContain("NEEDRESTART_SUSPEND=1");
        expect(s).toContain("Dpkg::Options::=--force-confold");
      }
    });
  });

  describe("wrapHostExec (run the patch on the HOST, not the agent container)", () => {
    const CHECK = { deadlineSec: 100, killSec: 5 };

    it("builds a one-shot privileged helper that nsenters PID 1 — with NO host-root mount or docker.sock", () => {
      const w = wrapHostExec(buildCheckScript(), CHECK);
      for (const flag of ["docker run", "--rm", "--pull never", "--name tugra-patch", "--privileged", "--pid=host", "--userns=host", "--network none", "tugra.role=patch-helper"]) {
        expect(w).toContain(flag);
      }
      expect(w).toContain("nsenter -t 1 -m -u -i -n -p");
      // host-root-equivalent via nsenter, NOT a standing host-root bind:
      expect(w).not.toContain("-v /:/host");
      expect(w).not.toContain("/var/run/docker.sock");
      expect(w).not.toContain("chroot");
      expect(w).not.toContain("nsenter -C"); // cgroup-ns omitted (fails on older kernels)
      expect(w).toContain("timeout -k 5 100");
    });

    it("takes the helper image ONLY from the trusted $TUGRA_AGENT_IMAGE env — never name/hostname (anti-spoof), no pull", () => {
      const w = wrapHostExec(buildCheckScript(), CHECK);
      expect(w).toContain('IMG="$TUGRA_AGENT_IMAGE"');
      // the name-spoofable path is GONE: a tenant could set container_name to the agent's id and hijack it.
      expect(w).not.toContain("docker inspect");
      expect(w).not.toContain("$(hostname)");
      // empty env fails closed, never patches the container
      expect(w).toContain('[ -n "$IMG" ] || { echo "TUGRA_HOST_UNAVAILABLE reason=no-image"; exit 1; }');
      expect(w).toContain("--pull never");
      expect(w).not.toContain("docker pull");
    });

    it("fails CLOSED on every unmet precondition — never silently patches the container", () => {
      const w = wrapHostExec(buildCheckScript(), CHECK);
      for (const reason of ["no-image", "not-host-pid", "userns", "no-nsenter"]) {
        expect(w).toContain(`TUGRA_HOST_UNAVAILABLE reason=${reason}`);
      }
      // the guards gate the payload: nsenter appears before the decoded payload is ever run
      expect(w.indexOf("command -v nsenter")).toBeLessThan(w.indexOf("base64 -d"));
    });

    it("carries the inner script ONLY as base64 — decodes byte-for-byte, so quoting/newlines survive", () => {
      const inner = buildCheckScript();
      const w = wrapHostExec(inner, CHECK);
      const m = /TUGRA_PATCH_B64='([A-Za-z0-9+/=]+)'/.exec(w);
      expect(m).not.toBeNull();
      const decoded = Buffer.from(m![1], "base64").toString("utf8");
      expect(decoded).toContain("TUGRA_HOST_ENTERED");
      expect(decoded.endsWith(inner)).toBe(true); // the exact inner script, incl. `apk version -l '<'` + newlines
      expect(decoded).toContain("apk version -l '<'");
    });

    it("a dangerous package name is still rejected UPSTREAM and never reaches the outer argv", () => {
      expect(() => wrapHostExec(buildUpgradeOneScript("x; rm -rf /"), CHECK)).toThrow(/invalid/);
      const w = wrapHostExec(buildUpgradeOneScript("openssl"), CHECK);
      // the only occurrence of the pkg is inside the base64 payload, not the outer shell
      const outer = w.replace(/TUGRA_PATCH_B64='[A-Za-z0-9+/=]+'/, "");
      expect(outer).not.toContain("openssl");
    });
  });

  describe("parseHostExec", () => {
    it("entered when the host marker is present", () => {
      expect(parseHostExec("TUGRA_HOST_ENTERED\nTUGRA_MGR=apt\n")).toMatchObject({ entered: true });
    });
    it("surfaces the unavailable reason (never parses as entered)", () => {
      const s = parseHostExec("TUGRA_HOST_UNAVAILABLE reason=userns\n");
      expect(s.entered).toBe(false);
      expect(s.unavailableReason).toBe("userns");
    });
    it("detects the name-mutex conflict as busy", () => {
      expect(parseHostExec('docker: Error response: Conflict. The container name "/tugra-patch" is already in use').busy).toBe(true);
    });
    it("no marker at all → not entered", () => {
      expect(parseHostExec("some unrelated output")).toMatchObject({ entered: false, busy: false });
    });
  });

  describe("interrupted dpkg finding", () => {
    it("parses the broken packages and flags the container engine", () => {
      const r = parseUpgradable(
        ["TUGRA_MGR=apt", "TUGRA_DPKG_BROKEN=docker-ce:half-configured", "TUGRA_DPKG_BROKEN=man-db:triggers-pending", "TUGRA_UPGRADABLE", "Listing..."].join("\n"),
      );
      expect(r.dpkgInterrupted).toEqual({
        packages: [
          { name: "docker-ce", state: "half-configured" },
          { name: "man-db", state: "triggers-pending" },
        ],
        containerEngine: true,
      });
    });
    it("is null on a clean dpkg and for non-apt managers", () => {
      expect(parseUpgradable("TUGRA_MGR=apt\nTUGRA_UPGRADABLE\n").dpkgInterrupted).toBeNull();
      expect(parseUpgradable("TUGRA_MGR=dnf\nTUGRA_DPKG_BROKEN=docker-ce:half-configured\nTUGRA_UPGRADABLE\n").dpkgInterrupted).toBeNull();
    });
    it("ignores unknown states; a non-engine package does not set the engine flag", () => {
      const r = parseUpgradable("TUGRA_MGR=apt\nTUGRA_DPKG_BROKEN=vim:half-configured\nTUGRA_DPKG_BROKEN=x:weird\nTUGRA_UPGRADABLE\n");
      expect(r.dpkgInterrupted).toEqual({ packages: [{ name: "vim", state: "half-configured" }], containerEngine: false });
    });
    it("applyRunning comes from the marker line only", () => {
      expect(parseUpgradable("TUGRA_MGR=apt\nTUGRA_PATCH_RUNNING\nTUGRA_UPGRADABLE\n").applyRunning).toBe(true);
      expect(parseUpgradable("TUGRA_MGR=apt\nTUGRA_UPGRADABLE\nfoo/x 1 amd64 [upgradable from: 0]\n").applyRunning).toBe(false);
    });
  });

  describe("isContainerEnginePackage", () => {
    it.each(["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "moby-engine", "moby-cli", "podman", "docker.io", "containerd.io.x86_64", "docker-ce.x86_64"])("%s is the engine", (n) => {
      expect(isContainerEnginePackage(n)).toBe(true);
    });
    it.each(["openssl", "vim", "docker-doc", "podman-compose-notes", "moby", "runc-extra", "libcontainerd"])("%s is not", (n) => {
      expect(isContainerEnginePackage(n)).toBe(false);
    });
  });

  describe("buildPatchRunScript", () => {
    const base = { id: "0123456789abcdef", deadlineSec: 1800, lines: 0, guard: { kind: "all" as const } };
    it("starts the package manager as a transient host unit and polls its state files", () => {
      const s = buildPatchRunScript("apt-get upgrade -y", base);
      expect(s).toContain("systemd-run --unit \"$UNIT\" --collect");
      expect(s).toContain('UNIT="tugra-patch-$ID"');
      expect(s).toContain("D='/etc/tugra/patch'");
      expect(s).toContain("TUGRA_PATCH_RC=");
      expect(s).toContain('systemctl is-active "$UNIT"');
      expect(s).toContain("sleep 2"); // the follower polls, it does not own the process
      // the inner script travels as base64 only
      expect(s).not.toContain("apt-get upgrade -y");
    });
    it("is idempotent per id: the unit is started only when its .run file does not exist yet", () => {
      expect(buildPatchRunScript("x", base)).toContain('if [ ! -f "$D/$ID.run" ]; then');
    });
    it("the fallback names the engine package list and runs the upgrade only after the guard", () => {
      const s = buildPatchRunScript("x", { ...base, guard: { kind: "one", pkg: "docker-ce" } });
      expect(s).toContain("TUGRA_PATCH_ENGINE_BLOCKED=");
      expect(s).toContain("PEND='docker-ce'");
      expect(s.indexOf("TUGRA_PATCH_ENGINE_BLOCKED")).toBeLessThan(s.lastIndexOf("base64 -d"));
    });
    it("validates every interpolated value", () => {
      expect(() => buildPatchRunScript("x", { ...base, id: "x; rm -rf /" })).toThrow(/invalid patch run id/);
      expect(() => buildPatchRunScript("x", { ...base, stateDir: "/tmp/a b" })).toThrow(/invalid patch run option/);
      expect(() => buildPatchRunScript("x", { ...base, pollSec: "1; reboot" })).toThrow(/invalid patch run option/);
      expect(() => buildPatchRunScript("x", { ...base, guard: { kind: "one", pkg: "a;b" } })).toThrow(/invalid package name/);
      expect(() => buildPatchRunScript("x", { ...base, lines: -1 })).toThrow(/invalid patch run bounds/);
      expect(() => buildPatchRunScript("x", { ...base, deadlineSec: 0 })).toThrow(/invalid patch run bounds/);
    });
    it("never reboots", () => {
      expect(buildPatchRunScript("x", base)).not.toMatch(/reboot|shutdown|systemctl (restart|stop)/);
    });
  });

  describe("parsePatchRun", () => {
    it("splits header, log and exit code; drops the newline the driver adds before the marker", () => {
      const r = parsePatchRun("TUGRA_HOST_ENTERED\nTUGRA_PATCH_MODE=unit\nTUGRA_PATCH_BEGIN\na\nb\n\nTUGRA_PATCH_RC=100\n");
      expect(r).toMatchObject({ mode: "unit", begun: true, log: "a\nb\n", rc: 100 });
    });
    it("an unfinished attach has a log and no rc", () => {
      expect(parsePatchRun("TUGRA_PATCH_MODE=unit\nTUGRA_PATCH_BEGIN\nhalf")).toMatchObject({ log: "half", rc: null, begun: true });
    });
    it("a marker-looking line inside the log is not an exit code unless it is the final marker line", () => {
      const r = parsePatchRun("TUGRA_PATCH_BEGIN\necho TUGRA_PATCH_RC=9 in text\n\nTUGRA_PATCH_RC=0\n");
      expect(r.rc).toBe(0);
      expect(r.log).toBe("echo TUGRA_PATCH_RC=9 in text\n");
    });
    it("reads the refusal / busy / start-failed markers", () => {
      expect(parsePatchRun("TUGRA_PATCH_MODE=inline\nTUGRA_PATCH_ENGINE_BLOCKED=docker-ce,containerd.io\n").engineBlocked).toEqual(["docker-ce", "containerd.io"]);
      expect(parsePatchRun("TUGRA_PATCH_BUSY\n").busy).toBe(true);
      expect(parsePatchRun("TUGRA_PATCH_START_FAILED\n").startFailed).toBe(true);
    });
  });

  it("wrapHostExec clears a STOPPED leftover helper by name (no -f: a running one stays the mutex)", () => {
    const w = wrapHostExec(buildCheckScript(), { deadlineSec: 100, killSec: 5 });
    expect(w).toContain("docker rm tugra-patch >/dev/null 2>&1 || true");
    expect(w).not.toContain("docker rm -f");
    expect(w.indexOf("docker rm tugra-patch")).toBeLessThan(w.indexOf("docker run"));
  });

  it("a TUGRA_PATCH_BUSY marker counts as busy", () => {
    expect(parseHostExec("TUGRA_HOST_ENTERED\nTUGRA_PATCH_BUSY\n").busy).toBe(true);
  });

  describe("Ubuntu phased updates", () => {
    // Real text from an Ubuntu 24.04 host (apt-get -s upgrade), snapd held back by the phased rollout.
    const SIM = [
      "Reading package lists...",
      "Building dependency tree...",
      "Reading state information...",
      "Calculating upgrade...",
      "The following upgrades have been deferred due to phasing:",
      "  snapd",
      "0 upgraded, 0 newly installed, 0 to remove and 1 not upgraded.",
      "",
    ].join("\n");
    const SNAPD = "snapd/noble-updates 2.78+ubuntu24.04 amd64 [upgradable from: 2.76.3+ubuntu24.04]";

    it("parsePhasedNames reads the deferred block of the real simulation output", () => {
      expect(parsePhasedNames(SIM)).toEqual(["snapd"]);
    });

    it("parsePhasedNames handles several packages over several lines, multiarch suffixes and a block-only input", () => {
      const block = [
        "The following upgrades have been deferred due to phasing:",
        "  snapd libc6:i386 ubuntu-advantage-tools",
        "  gnome-shell",
        "The following packages have been kept back:",
        "  not-phased",
      ].join("\n");
      expect(parsePhasedNames(block)).toEqual(["snapd", "libc6", "ubuntu-advantage-tools", "gnome-shell"]);
    });

    it("parsePhasedNames is empty without the header (no phasing, or an apt that prints nothing)", () => {
      expect(parsePhasedNames("")).toEqual([]);
      expect(parsePhasedNames("Calculating upgrade...\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n")).toEqual([]);
      expect(parsePhasedNames("The following packages have been kept back:\n  linux-image\n")).toEqual([]);
    });

    it("splits phased packages out of the list and excludes them from the count", () => {
      const out = [
        "TUGRA_MGR=apt",
        "TUGRA_UPGRADABLE",
        "Listing...",
        SNAPD,
        "vim/noble-updates 2:9.1.0016-1ubuntu7.16 amd64 [upgradable from: 2:9.1.0016-1ubuntu7.15]",
        "TUGRA_REBOOT",
        "TUGRA_PHASED_SIM",
        "The following upgrades have been deferred due to phasing:",
        "  snapd",
        "",
      ].join("\n");
      const r = parseUpgradable(out);
      expect(r.count).toBe(1);
      expect(r.packages.map((p) => p.name)).toEqual(["vim"]);
      expect(r.phased).toEqual([{ name: "snapd", group: "other", candidate: "2.78+ubuntu24.04", current: "2.76.3+ubuntu24.04" }]);
      expect(r.rebootRequired).toBe(true);
    });

    it("the proven case: one upgradable package that is phased means count 0 and one phased entry", () => {
      const r = parseUpgradable(["TUGRA_MGR=apt", "TUGRA_UPGRADABLE", "Listing...", SNAPD, "TUGRA_PHASED_SIM", SIM].join("\n"));
      expect(r.count).toBe(0);
      expect(r.packages).toEqual([]);
      expect(r.phased.map((p) => p.name)).toEqual(["snapd"]);
    });

    it("without a phasing block everything stays in the normal list; non-apt managers never report phased", () => {
      const apt = parseUpgradable(["TUGRA_MGR=apt", "TUGRA_UPGRADABLE", SNAPD, "TUGRA_PHASED_SIM", ""].join("\n"));
      expect(apt.count).toBe(1);
      expect(apt.phased).toEqual([]);
      // an old check output with no simulation marker at all
      expect(parseUpgradable(["TUGRA_MGR=apt", "TUGRA_UPGRADABLE", SNAPD].join("\n")).phased).toEqual([]);
      const dnf = parseUpgradable("TUGRA_MGR=dnf\nTUGRA_UPGRADABLE\ncurl.x86_64  7.76.1  baseos\nTUGRA_PHASED_SIM\n" + SIM);
      expect(dnf.count).toBe(1);
      expect(dnf.phased).toEqual([]);
      expect(parseUpgradable("TUGRA_UNSUPPORTED").phased).toEqual([]);
    });

    it("a deferred name that apt does not list as upgradable is ignored (no phantom row)", () => {
      const r = parseUpgradable(["TUGRA_MGR=apt", "TUGRA_UPGRADABLE", "TUGRA_PHASED_SIM", SIM].join("\n"));
      expect(r.phased).toEqual([]);
      expect(r.count).toBe(0);
    });

    it("the forced per-package install carries the phasing override; no other script does", () => {
      const forced = buildInstallPhasedScript("snapd");
      expect(forced).toContain("-o APT::Get::Always-Include-Phased-Updates=true install --only-upgrade -y snapd");
      expect(forced).toContain("dpkg --configure -a"); // same heal as every apply
      expect(forced).not.toContain("dnf");
      for (const s of [buildUpgradeAllScript(), buildUpgradeOneScript("snapd"), buildCheckScript()]) {
        expect(s).not.toContain("Always-Include-Phased-Updates");
      }
      expect(() => buildInstallPhasedScript("evil; rm -rf /")).toThrow(/invalid/);
      expect(() => buildInstallPhasedScript("--force")).toThrow(/invalid/);
    });
  });
});
