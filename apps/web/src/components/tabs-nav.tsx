"use client";

import type { LucideIcon } from "lucide-react";

/** Underline tab strip for detail pages. Controlled via `active`/`onChange`. */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string; badge?: number; icon?: LucideIcon }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div
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
            type="button"
            onClick={() => onChange(tab.key)}
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: on ? 600 : 500,
              color: on ? "var(--c-tx)" : "var(--c-tx3)",
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${on ? "var(--c-a)" : "transparent"}`,
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
