/** Parse "v0.1.0-beta.27" / "1.2.3" into numeric core + prerelease identifiers; null when it is not a version. */
function parse(v: string): { core: number[]; pre: (string | number)[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** Semver-style compare (a prerelease sorts before its release). null when either side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    if (typeof p === "number") return -1; // numeric identifiers sort before alphanumeric ones
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export type AgentVersionState = "current" | "outdated" | "unknown";

/** Is the agent on the version the fleet should run? `target` = the newest published release (or the hub's own). */
export function agentVersionState(agentVersion: string | null | undefined, target: string | null | undefined): AgentVersionState {
  if (!agentVersion || !target) return "unknown";
  const c = compareVersions(agentVersion, target);
  if (c === null) return "unknown";
  return c < 0 ? "outdated" : "current";
}
