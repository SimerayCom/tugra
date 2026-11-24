"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The Command Center is a list of cards the user can show/hide and reorder. There is no per-user preference
 * store on the hub yet, so the layout is remembered in this browser (one entry per signed-in user, so a shared
 * machine keeps separate layouts). Everything below the hook is pure and unit-tested.
 */

/** Every card the dashboard can show, in the default order. New ids go at the end of their group; a saved layout
 *  that predates a card simply gets it appended (see normalizeLayout). */
export const DASHBOARD_CARDS = [
  "attention",
  "fleet",
  "hottest",
  "diskForecast",
  "certs",
  "backups",
  "updates",
  "uptime",
  "deploys",
  "migrations",
  "resources",
  "projects",
  "servers",
  "activity",
] as const;
export type DashboardCardId = (typeof DASHBOARD_CARDS)[number];

export interface DashboardLayout {
  order: DashboardCardId[];
  hidden: DashboardCardId[];
}

/** Cards that start hidden so the first view is not a wall of widgets; the user can turn them on. */
const DEFAULT_HIDDEN: DashboardCardId[] = ["migrations"];

export const defaultLayout = (): DashboardLayout => ({ order: [...DASHBOARD_CARDS], hidden: [...DEFAULT_HIDDEN] });

const isCard = (v: unknown): v is DashboardCardId => typeof v === "string" && (DASHBOARD_CARDS as readonly string[]).includes(v);

/** Make any stored value safe: drop unknown / duplicate ids, append cards added since it was saved. */
export function normalizeLayout(raw: unknown): DashboardLayout {
  const base = defaultLayout();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as { order?: unknown; hidden?: unknown };
  const order: DashboardCardId[] = [];
  for (const id of Array.isArray(r.order) ? r.order : []) if (isCard(id) && !order.includes(id)) order.push(id);
  const known = new Set(order);
  // A card the saved layout has never heard of is new: show it in its default position among the others.
  for (const id of DASHBOARD_CARDS) {
    if (known.has(id)) continue;
    const prevDefault = DASHBOARD_CARDS[DASHBOARD_CARDS.indexOf(id) - 1];
    const at = prevDefault ? order.indexOf(prevDefault) : -1;
    order.splice(at + 1, 0, id);
    known.add(id);
  }
  const hasSavedHidden = Array.isArray(r.hidden);
  const hidden = (hasSavedHidden ? (r.hidden as unknown[]) : DEFAULT_HIDDEN).filter(isCard);
  // New-since-save cards honour their default visibility; known ones keep what the user chose.
  const savedKnown = new Set((Array.isArray(r.order) ? r.order : []).filter(isCard));
  for (const id of DEFAULT_HIDDEN) if (!savedKnown.has(id) && !hidden.includes(id)) hidden.push(id);
  return { order, hidden: [...new Set(hidden)] };
}

/** Move `id` one step up/down in the order (no-op at the ends). */
export function moveCard(layout: DashboardLayout, id: DashboardCardId, dir: -1 | 1): DashboardLayout {
  const i = layout.order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= layout.order.length) return layout;
  const order = [...layout.order];
  [order[i], order[j]] = [order[j], order[i]];
  return { ...layout, order };
}

/** Move `id` to the position currently held by `target` (drag and drop). */
export function dropCard(layout: DashboardLayout, id: DashboardCardId, target: DashboardCardId): DashboardLayout {
  if (id === target) return layout;
  const from = layout.order.indexOf(id);
  const to = layout.order.indexOf(target);
  if (from < 0 || to < 0) return layout;
  const order = [...layout.order];
  order.splice(from, 1);
  order.splice(to, 0, id);
  return { ...layout, order };
}

export function toggleCard(layout: DashboardLayout, id: DashboardCardId): DashboardLayout {
  const hidden = layout.hidden.includes(id) ? layout.hidden.filter((h) => h !== id) : [...layout.hidden, id];
  return { ...layout, hidden };
}

/** The cards to render, in order. */
export const visibleCards = (layout: DashboardLayout): DashboardCardId[] => layout.order.filter((id) => !layout.hidden.includes(id));

const key = (userId: string | null | undefined) => `tugra.dashboardLayout.${userId ?? "anon"}`;

export function readLayout(userId: string | null | undefined): DashboardLayout {
  try {
    const raw = localStorage.getItem(key(userId));
    return normalizeLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultLayout();
  }
}

export function useDashboardLayout(userId: string | null | undefined): [DashboardLayout, (next: DashboardLayout) => void, () => void] {
  const [layout, setLayout] = useState<DashboardLayout>(defaultLayout);
  useEffect(() => setLayout(readLayout(userId)), [userId]);
  const save = useCallback(
    (next: DashboardLayout) => {
      setLayout(next);
      try {
        localStorage.setItem(key(userId), JSON.stringify(next));
      } catch {
        /* private mode: the layout just isn't remembered */
      }
    },
    [userId],
  );
  const reset = useCallback(() => {
    setLayout(defaultLayout());
    try {
      localStorage.removeItem(key(userId));
    } catch {
      /* ignore */
    }
  }, [userId]);
  return [layout, save, reset];
}
