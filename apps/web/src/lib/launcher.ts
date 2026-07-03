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
