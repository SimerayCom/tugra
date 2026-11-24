import type { HomeFolder } from "./home-mode";

// Per-browser Home layout: tile order, folders, grouping, wallpaper, widgets. Like pins, this is a convenience
// that doesn't need to roam, so it lives in localStorage; every access is wrapped and every read validated so a
// blocked or corrupted store never breaks the launcher.
const KEY = "tugra.home.layout";

export const GROUP_MODES = ["auto", "team", "folders", "none"] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

export const WALLPAPERS = ["none", "dusk", "ocean", "forest", "ember"] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];

export const WIDGETS = ["servers", "storage", "backups", "uptime"] as const;
export type WidgetId = (typeof WIDGETS)[number];

export interface HomeLayout {
  order: string[]; // app ids, user-chosen order (apps not listed follow in default order)
  folders: HomeFolder[];
  groupMode: GroupMode;
  wallpaper: Wallpaper;
  widgets: Record<WidgetId, boolean>;
  gaugeServerId: string | null; // the server the gauges and the storage/uptime widgets show
  fleetHintDismissed: boolean;
}

export const DEFAULT_LAYOUT: HomeLayout = {
  order: [],
  folders: [],
  groupMode: "auto",
  wallpaper: "none",
  widgets: { servers: true, storage: true, backups: true, uptime: true },
  gaugeServerId: null,
  fleetHintDismissed: false,
};

const isStr = (x: unknown): x is string => typeof x === "string";
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter(isStr) : []);

/** Coerce anything read from storage into a valid layout (unknown fields dropped, bad fields defaulted). */
export function sanitizeLayout(raw: unknown): HomeLayout {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const folders: HomeFolder[] = Array.isArray(o.folders)
    ? o.folders
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && isStr((f as Record<string, unknown>).id) && isStr((f as Record<string, unknown>).name))
        .map((f) => ({ id: f.id as string, name: (f.name as string).slice(0, 60), tileIds: strings(f.tileIds) }))
    : [];
  const w = o.widgets && typeof o.widgets === "object" ? (o.widgets as Record<string, unknown>) : {};
  const widgets = { ...DEFAULT_LAYOUT.widgets };
  for (const id of WIDGETS) if (typeof w[id] === "boolean") widgets[id] = w[id] as boolean;
  return {
    order: strings(o.order),
    folders,
    groupMode: GROUP_MODES.includes(o.groupMode as GroupMode) ? (o.groupMode as GroupMode) : "auto",
    wallpaper: WALLPAPERS.includes(o.wallpaper as Wallpaper) ? (o.wallpaper as Wallpaper) : "none",
    widgets,
    gaugeServerId: isStr(o.gaugeServerId) ? o.gaugeServerId : null,
    fleetHintDismissed: o.fleetHintDismissed === true,
  };
}

export function loadLayout(): HomeLayout {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeLayout(null);
  }
}

export function saveLayout(layout: HomeLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable — the layout just doesn't persist this session */
  }
}

/** Resolve "auto" to a concrete view: team grouping once tiles span several teams, folders once any exist. */
export function effectiveGroupMode(layout: Pick<HomeLayout, "groupMode" | "folders">, teamCount: number): Exclude<GroupMode, "auto"> {
  if (layout.groupMode !== "auto") return layout.groupMode;
  if (teamCount > 1) return "team";
  return layout.folders.length > 0 ? "folders" : "none";
}

/** Soft, theme-aware backgrounds: a faint tint mixed into the page canvas so text contrast is never at risk. */
export const WALLPAPER_CSS: Record<Wallpaper, string | undefined> = {
  none: undefined,
  dusk: "linear-gradient(135deg, color-mix(in srgb, #6d5be6 20%, var(--c-bg)), color-mix(in srgb, #d6558f 14%, var(--c-bg)))",
  ocean: "linear-gradient(135deg, color-mix(in srgb, #2b8fd6 20%, var(--c-bg)), color-mix(in srgb, #2bc4b0 14%, var(--c-bg)))",
  forest: "linear-gradient(135deg, color-mix(in srgb, #3f9d5c 20%, var(--c-bg)), color-mix(in srgb, #9bb83a 12%, var(--c-bg)))",
  ember: "linear-gradient(135deg, color-mix(in srgb, #e0803a 20%, var(--c-bg)), color-mix(in srgb, #d6454a 14%, var(--c-bg)))",
};
