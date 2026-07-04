import { Box, GitBranch, Layers, type LucideIcon } from "lucide-react";
import type { Application, AppStatus, AppSource } from "./types";

// One tile on the Home launcher: an installed app you can open in the browser.
export interface LauncherTile {
  id: string;
  name: string;
  url: string | null; // pre-built public URL, or null when the app has no domain yet
  status: AppStatus;
  source: AppSource;
  templateSlug: string | null; // catalog slug → brand logo, when installed from a template
  templateLogo: string | null;
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
export type TileAction = "open" | "start" | "restart" | "stop" | "addDomain" | "uninstall";

export function tileActions(status: AppStatus, hasUrl: boolean): TileAction[] {
  const running = status === "RUNNING";
  const actions: TileAction[] = [];
  if (hasUrl) actions.push("open");
  if (!running) actions.push("start"); // deploy = build+run, works from NEW/STOPPED/FAILED
  if (running) actions.push("restart", "stop");
  if (!hasUrl) actions.push("addDomain");
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
      source: a.source,
      templateSlug: a.templateSlug,
      templateLogo: a.templateLogo,
    }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
