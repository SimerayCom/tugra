"use client";

import { useRef, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * Underline tab strip for detail pages. Controlled via `active`/`onChange`.
 *
 * Accessible tabs pattern: `tablist` + `tab` (aria-selected), roving tabindex (only the active tab
 * is in the Tab order) and ArrowLeft/ArrowRight/Home/End move + activate. When `idPrefix` is given the
 * tabs get stable ids and `aria-controls` pointing at `${idPrefix}-panel-${key}`, which the page's
 * `role="tabpanel"` should use; without it no dangling aria-controls is emitted.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  idPrefix,
  label,
}: {
  tabs: { key: string; label: string; badge?: number; icon?: LucideIcon }[];
  active: string;
  onChange: (key: string) => void;
  idPrefix?: string;
  label?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return;
    // Leave browser/OS shortcuts (e.g. Alt+Arrow history navigation) alone.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // `active` can lag a keypress (onChange may route-push), so derive the current tab from DOM focus
    // first and only fall back to the prop.
    const focused = document.activeElement;
    let from = tabs.findIndex((t) => refs.current[t.key] === focused);
    if (from < 0) from = tabs.findIndex((t) => t.key === active);
    let to = -1;
    if (e.key === "ArrowRight") to = from < 0 ? 0 : (from + 1) % tabs.length;
    else if (e.key === "ArrowLeft") to = from < 0 ? tabs.length - 1 : (from - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = tabs.length - 1;
    if (to < 0) return;
    e.preventDefault();
    const next = tabs[to];
    onChange(next.key);
    refs.current[next.key]?.focus();
  };
  // If `active` matches no tab, keep the strip reachable by letting the first tab take the tab stop.
  const stop = tabs.some((t) => t.key === active) ? active : tabs[0]?.key;
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--c-bd)",
        marginBottom: 20,
        overflowX: "auto",
        // Only the tab strip scrolls horizontally when it overflows. Without pinning overflow-y, CSS
        // promotes it from `visible` to `auto` (because overflow-x is set), and the buttons' -1px
        // bottom margin then triggers a spurious vertical scrollbar.
        overflowY: "hidden",
      }}
    >
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[tab.key] = el;
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${tab.key}` : undefined}
            aria-selected={on}
            aria-controls={idPrefix ? `${idPrefix}-panel-${tab.key}` : undefined}
            tabIndex={tab.key === stop ? 0 : -1}
            className="tg-tab"
            onClick={() => onChange(tab.key)}
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              // border reset + background / color / weight / underline for the selected + hover states live in .tg-tab (CSS).
              padding: "9px 12px",
              marginBottom: -1,
              cursor: "pointer",
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {tab.icon && <tab.icon size={14} aria-hidden style={{ flexShrink: 0 }} />}
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  background: "var(--c-el)",
                  color: "var(--c-tx3)",
                  borderRadius: 999,
                  padding: "1px 6px",
                }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
