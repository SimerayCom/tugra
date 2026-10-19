import { Box, GitBranch, Layers, type LucideIcon } from "lucide-react";
import type { Application, AppStatus, AppSource } from "./types";

// A launcher tile's lifecycle state, derived from AppStatus for a plain-language label.
export type TilePhase = "running" | "stopped" | "failed" | "new";
// How an app is reachable — drives whether "Open" is shown as secure or flagged as a raw IP link.
export type LinkKind = "tunnel" | "domain" | "ip" | "none";

// One tile on the Home launcher: an installed app you can open in the browser.
export interface LauncherTile {
  id: string;
  name: string;
  url: string | null; // pre-built public URL, or null when the app has no domain yet
  status: AppStatus;
  phase: TilePhase; // derived from status — for the tile's status label
  linkKind: LinkKind; // derived from url/domain/tunnelExposed — tunnel/domain are secure, ip is flagged
  source: AppSource;
  templateSlug: string | null; // catalog slug → brand logo, when installed from a template
  templateLogo: string | null;
  exposeMode: string; // current exposure — seeds the Expose modal so it reflects reality
  domain: string | null;
  tunnelExposed: boolean; // reachable via Cloudflare tunnel (secure, no open port)
  canWrite: boolean;
}

/** Plain-language lifecycle state for the tile's status label. */
export function tilePhase(status: AppStatus): TilePhase {
  switch (status) {
    case "RUNNING":
      return "running";
    case "STOPPED":
      return "stopped";
    case "FAILED":
      return "failed";
    default:
      return "new";
  }
}

/** How the app is reachable. A tunnel or a real domain is HTTPS/secure; a bare http://ip:port link works but is
 *  flagged so the user can add a secure link. `none` = no URL yet. */
export function deriveLinkKind(t: { url: string | null; domain: string | null; tunnelExposed: boolean }): LinkKind {
  if (!t.url) return "none";
  if (t.tunnelExposed) return "tunnel";
  if (t.domain) return "domain";
  return "ip";
}

const SOURCE_ICON: Record<AppSource, LucideIcon> = {
  IMAGE: Box,
  GIT: GitBranch,
  COMPOSE: Layers,
};

export function launcherIcon(source: AppSource): LucideIcon {
  return SOURCE_ICON[source] ?? Box;
}

// Openable + running first, then openable-but-not-running, then apps with no
// domain (can't be launched) — each group sorted by name.
function rank(t: LauncherTile): number {
  if (!t.url) return 2;
  return t.status === "RUNNING" ? 0 : 1;
}

// Per-app management actions offered on a launcher tile, given its state.
export type TileAction = "open" | "logs" | "files" | "start" | "restart" | "update" | "stop" | "expose" | "uninstall";

export function tileActions(status: AppStatus, hasUrl: boolean, canWrite: boolean): TileAction[] {
  const running = status === "RUNNING";
  const actions: TileAction[] = [];
  if (hasUrl) actions.push("open");
  // Everything below mutates the app or reads its internals → only offered to writers (viewers 403).
  if (!canWrite) return actions;
  if (status !== "NEW") actions.push("logs", "files"); // a never-deployed app has no logs/volume yet
  if (!running) actions.push("start"); // deploy = build+run, works from NEW/STOPPED/FAILED
  if (running) actions.push("restart", "update", "stop"); // "update" = redeploy (pull latest + restart)
  // "Expose" always available to writers: give a urlless app an instant URL, or
  // change how a reachable one is exposed (magic / port / custom domain).
  actions.push("expose");
  actions.push("uninstall");
  return actions;
}

export function launcherTiles(apps: Application[]): LauncherTile[] {
  return apps
    .map((a) => ({
      id: a.id,
      name: a.name,
      url: a.url,
      status: a.status,
      phase: tilePhase(a.status),
      linkKind: deriveLinkKind({ url: a.url, domain: a.domain, tunnelExposed: a.tunnelExposed }),
      source: a.source,
      templateSlug: a.templateSlug,
      templateLogo: a.templateLogo,
      exposeMode: a.exposeMode,
      domain: a.domain,
      tunnelExposed: a.tunnelExposed,
      canWrite: a.canWrite,
    }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
