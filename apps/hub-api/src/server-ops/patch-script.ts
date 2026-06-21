/**
 * Pure builders + parser for OS package patching (apt / Debian-Ubuntu only).
 * The agent runs these shell scripts as-is; output is parsed back here.
 * Markers (TUGRA_*) let us detect unsupported distros / reboot-required without
 * a second round-trip.
 */

const PKG_RE = /^[a-z0-9][a-z0-9.+-]*$/;

/** Refresh the index, list upgradables, flag reboot-required. apt-only. */
export function buildCheckScript(): string {
  return [
    "command -v apt-get >/dev/null 2>&1 || { echo TUGRA_UNSUPPORTED; exit 0; }",
    "apt-get update -qq >/dev/null 2>&1 || true",
    "echo TUGRA_UPGRADABLE",
    "apt list --upgradable 2>/dev/null",
    "[ -f /var/run/reboot-required ] && echo TUGRA_REBOOT || true",
  ].join("\n");
}

export function buildUpgradeAllScript(): string {
  return "DEBIAN_FRONTEND=noninteractive apt-get upgrade -y";
}

export function buildUpgradeOneScript(pkg: string): string {
  if (!PKG_RE.test(pkg)) throw new Error("invalid package name");
  return `DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y ${pkg}`;
}

export interface UpgradablePackage {
  name: string;
  current: string;
  candidate: string;
}

export interface PatchInfo {
  supported: boolean;
  rebootRequired: boolean;
  packages: UpgradablePackage[];
  count: number;
}

// e.g. "docker-ce/noble 5:29.6.0-1~noble amd64 [upgradable from: 5:29.5.0-1~noble]"
const LINE_RE = /^([a-z0-9][a-z0-9.+-]*)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/i;

/** Parse the agent's check-script output into structured update info. */
export function parseUpgradable(output: string): PatchInfo {
  if (output.includes("TUGRA_UNSUPPORTED")) {
    return { supported: false, rebootRequired: false, packages: [], count: 0 };
  }
  const rebootRequired = output.includes("TUGRA_REBOOT");
  const packages: UpgradablePackage[] = [];
  for (const line of output.split("\n")) {
    const m = LINE_RE.exec(line.trim());
    if (m) packages.push({ name: m[1], candidate: m[2], current: m[3].trim() });
  }
  return { supported: true, rebootRequired, packages, count: packages.length };
}
