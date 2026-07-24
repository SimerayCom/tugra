/**
 * Pure builders + parser for OS package patching. Auto-detects the server's package
 * manager (apt / dnf / yum / apk) so the same Tugra "check / upgrade" flow works on
 * Debian-Ubuntu, RHEL-Rocky-Fedora and Alpine. The agent runs these shell scripts
 * as-is; output is parsed back here. Markers (TUGRA_*) carry the manager, the upgradable
 * list and reboot-required back without a second round-trip.
 */

// Allows the name forms every manager uses (incl. dnf's `name.x86_64` arch suffix with `_`, and
// capitalised RPM names like NetworkManager). Rejects shell metacharacters, spaces and leading flags.
const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export type PkgManager = "apt" | "dnf" | "yum" | "apk";

/**
 * Refresh the index, list upgradables, flag reboot-required — for whichever package
 * manager the server has. Emits `TUGRA_MGR=<mgr>`, then `TUGRA_UPGRADABLE` + the raw list,
 * then `TUGRA_REBOOT` when a reboot is pending. `TUGRA_UNSUPPORTED` when no manager is found.
 */
export function buildCheckScript(): string {
  return [
    "if command -v apt-get >/dev/null 2>&1; then",
    "  echo TUGRA_MGR=apt",
    "  apt-get update -qq >/dev/null 2>&1 || true",
    "  echo TUGRA_UPGRADABLE",
    "  apt list --upgradable 2>/dev/null",
    "  [ -f /var/run/reboot-required ] && echo TUGRA_REBOOT || true",
    "elif command -v dnf >/dev/null 2>&1; then",
    "  echo TUGRA_MGR=dnf",
    "  echo TUGRA_UPGRADABLE",
    "  COLUMNS=1000 dnf -q check-update 2>/dev/null", // wide COLUMNS stops long names wrapping onto 2 lines
    "  rc=$?", // check-update: 0 = none, 100 = updates available, anything else = the check itself failed
    '  [ "$rc" -ne 0 ] && [ "$rc" -ne 100 ] && echo TUGRA_CHECK_FAILED',
    "  command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo TUGRA_REBOOT; } || true",
    "elif command -v yum >/dev/null 2>&1; then",
    "  echo TUGRA_MGR=yum",
    "  echo TUGRA_UPGRADABLE",
    "  COLUMNS=1000 yum -q check-update 2>/dev/null",
    "  rc=$?",
    '  [ "$rc" -ne 0 ] && [ "$rc" -ne 100 ] && echo TUGRA_CHECK_FAILED',
    "  command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo TUGRA_REBOOT; } || true",
    "elif command -v apk >/dev/null 2>&1; then",
    "  echo TUGRA_MGR=apk",
    "  apk update >/dev/null 2>&1 || true",
    "  echo TUGRA_UPGRADABLE",
    "  apk version -l '<' 2>/dev/null", // list world packages whose installed < available
    "else",
    "  echo TUGRA_UNSUPPORTED",
    "fi",
  ].join("\n");
}

/** Upgrade every package, for whichever manager the server has. */
export function buildUpgradeAllScript(): string {
  return [
    "if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get upgrade -y;",
    "elif command -v dnf >/dev/null 2>&1; then dnf -y upgrade;",
    "elif command -v yum >/dev/null 2>&1; then yum -y update;",
    "elif command -v apk >/dev/null 2>&1; then apk upgrade;",
    "else echo TUGRA_UNSUPPORTED; exit 1; fi",
  ].join("\n");
}

/** Upgrade a single package. `pkg` is strictly validated (no shell metacharacters / flags). */
export function buildUpgradeOneScript(pkg: string): string {
  if (!PKG_RE.test(pkg)) throw new Error("invalid package name");
  return [
    `if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y ${pkg};`,
    `elif command -v dnf >/dev/null 2>&1; then dnf -y upgrade ${pkg};`,
    `elif command -v yum >/dev/null 2>&1; then yum -y update ${pkg};`,
    `elif command -v apk >/dev/null 2>&1; then apk upgrade ${pkg};`,
    "else echo TUGRA_UNSUPPORTED; exit 1; fi",
  ].join("\n");
}

export interface UpgradablePackage {
  name: string;
  current: string; // "" when the manager's check doesn't report the installed version (dnf/yum)
  candidate: string;
}

export interface PatchInfo {
  supported: boolean;
  manager: PkgManager | null;
  checkFailed: boolean; // the manager's check ran but errored (repo unreachable / bad GPG) — result is NOT "up to date"
  rebootRequired: boolean;
  packages: UpgradablePackage[];
  count: number;
}

// apt: "docker-ce/noble 5:29.6.0-1~noble amd64 [upgradable from: 5:29.5.0-1~noble]"
const APT_RE = /^([a-z0-9][a-z0-9.+-]*)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/i;
// dnf/yum -q check-update: "curl.x86_64   7.76.1-26.el9_3.2   baseos" (exactly 3 columns)
const RPM_RE = /^([a-zA-Z0-9][a-zA-Z0-9._+-]*)\s+(\S+)\s+(\S+)\s*$/;
// apk version -l '<': "zlib-1.2.13-r0 < 1.2.13-r1" (name-installed < available)
const APK_RE = /^(.+)-(\d[^\s]*)\s+<\s+(\S+)\s*$/;

function readManager(output: string): PkgManager | null {
  const m = /TUGRA_MGR=(apt|dnf|yum|apk)/.exec(output);
  return m ? (m[1] as PkgManager) : null;
}

const UNSUPPORTED: PatchInfo = { supported: false, manager: null, checkFailed: false, rebootRequired: false, packages: [], count: 0 };

/** Parse the agent's check-script output into structured update info (manager-aware). */
export function parseUpgradable(output: string): PatchInfo {
  if (output.includes("TUGRA_UNSUPPORTED")) return UNSUPPORTED;
  const manager = readManager(output);
  if (!manager) return UNSUPPORTED;

  const checkFailed = output.includes("TUGRA_CHECK_FAILED");
  const rebootRequired = output.includes("TUGRA_REBOOT");
  const packages: UpgradablePackage[] = [];
  // Only the lines after the TUGRA_UPGRADABLE marker are the package list.
  const start = output.indexOf("TUGRA_UPGRADABLE");
  const body = start >= 0 ? output.slice(start + "TUGRA_UPGRADABLE".length) : output;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("TUGRA_") || line.startsWith("Listing")) continue;
    if (manager === "apt") {
      const m = APT_RE.exec(line);
      if (m) packages.push({ name: m[1], candidate: m[2], current: m[3].trim() });
    } else if (manager === "apk") {
      const m = APK_RE.exec(line);
      if (m) packages.push({ name: m[1], current: m[2], candidate: m[3] });
    } else {
      // dnf / yum: check-update reports the available version + repo, not the installed one.
      const lower = line.toLowerCase();
      if (lower.startsWith("last metadata")) continue;
      // "Obsoleting Packages" is a trailing informational block (an obsoleting pkg followed by an
      // indented already-installed pkg). `dnf/yum upgrade` handles obsoletes itself, so stop here
      // rather than list those rows as phantom upgrades (the indented @System line would otherwise
      // trim to a normal 3-column match and inflate the count with an already-installed version).
      if (lower.startsWith("obsoleting")) break;
      const m = RPM_RE.exec(line);
      // Skip installed packages (repo column @System / @anaconda / …) — never an available upgrade.
      if (m && !m[3].startsWith("@")) {
        packages.push({ name: m[1], candidate: m[2], current: "" });
      }
    }
  }
  return { supported: true, manager, checkFailed, rebootRequired, packages, count: packages.length };
}
