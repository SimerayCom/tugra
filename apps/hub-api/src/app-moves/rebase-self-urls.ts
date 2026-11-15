/**
 * Template compose apps bake their OWN address (the app's magic domain and/or the server's public IP) into the
 * compose YAML and into config-mount files (real-url substitution at install). When an app moves to another
 * server those self-references must follow it. Pure + table-tested; mirrors the precedent in
 * ApplicationsService.regenerateMagicForServer (domain: exact split/join) and adds an exact-token IP replacement.
 *
 * Env VALUES are never rewritten here (they may legitimately point at the old host on purpose); the preflight warns
 * with the key names instead.
 */

export interface SelfAddr {
  ip: string | null;
  domain: string | null;
}

export interface RebasableApp {
  composeFile: string | null;
  configMounts: unknown;
}

export interface RebaseResult {
  composeFile: string | null;
  configMounts: unknown;
  changed: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace `from` with `to` where `from` is an EXACT IP token: an IPv4 is bounded by anything but [0-9.] (so
 *  10.0.0.12 never matches inside 10.0.0.123 or 110.0.0.12), an IPv6 by anything but [0-9a-fA-F:.]. */
export function replaceIpToken(text: string, from: string, to: string): string {
  const isV6 = from.includes(":");
  const cls = isV6 ? "0-9a-fA-F:." : "0-9.";
  const re = new RegExp(`(?<![${cls}])${escapeRe(from)}(?![${cls}])`, "g");
  return text.replace(re, () => to);
}

function rebaseText(text: string, from: SelfAddr, to: SelfAddr): string {
  let out = text;
  if (from.domain && to.domain && from.domain !== to.domain) out = out.split(from.domain).join(to.domain);
  if (from.ip && to.ip && from.ip !== to.ip) out = replaceIpToken(out, from.ip, to.ip);
  return out;
}

export function rebaseSelfUrls(app: RebasableApp, from: SelfAddr, to: SelfAddr): RebaseResult {
  let changed = false;
  let composeFile = app.composeFile;
  if (typeof composeFile === "string") {
    const next = rebaseText(composeFile, from, to);
    if (next !== composeFile) {
      composeFile = next;
      changed = true;
    }
  }
  let configMounts = app.configMounts;
  if (Array.isArray(configMounts)) {
    let mountsChanged = false;
    const mapped = (configMounts as { content?: unknown }[]).map((m) => {
      if (m && typeof m === "object" && typeof m.content === "string") {
        const next = rebaseText(m.content, from, to);
        if (next !== m.content) {
          mountsChanged = true;
          return { ...m, content: next };
        }
      }
      return m;
    });
    if (mountsChanged) {
      configMounts = mapped;
      changed = true;
    }
  }
  return { composeFile, configMounts, changed };
}
