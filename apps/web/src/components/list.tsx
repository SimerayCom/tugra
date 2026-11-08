"use client";

import Link from "next/link";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { clickedInteractive } from "../lib/row-nav";

/**
 * Bordered list container shared by the list pages (apps, projects, domains, monitors, dashboard).
 * overflow:hidden clips the rounded corners, which is why rows inset their focus ring (.tg-row).
 */
export function ListCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden", ...style }}>
      {children}
    </div>
  );
}

const rowBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 16px",
  color: "var(--c-tx)",
};

/**
 * One row of a ListCard. `index` drives the divider: only rows after the first draw a top border, so
 * the container's own border is never doubled.
 *
 * - `href`     → the row IS a real <Link> (keyboard + middle-click + a11y for free); children must not
 *                contain other links/buttons (use `onClick` for rows with nested actions).
 * - `onClick`  → a div that navigates on click, ignoring clicks that land on a nested control (link,
 *                button, checkbox…) so those keep working. Focusable + Enter/Space-activatable unless
 *                `tabbable={false}` (use that when a nested link already is the keyboard path).
 * - neither    → a static row: no hover/pointer affordance, since nothing happens on click.
 *
 * Only navigating rows carry `.tg-row` (hover/press wash + inset focus ring).
 */
export function ListRow({
  index = 0,
  href,
  onClick,
  tabbable = true,
  children,
  style,
}: {
  index?: number;
  href?: string;
  onClick?: () => void;
  tabbable?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const rowStyle: CSSProperties = {
    ...rowBase,
    borderTop: index > 0 ? "1px solid var(--c-bd)" : "none",
    ...style,
  };

  if (href) {
    return (
      <Link href={href} className="tg-row" style={{ ...rowStyle, textDecoration: "none" }}>
        {children}
      </Link>
    );
  }

  if (onClick) {
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      // Only the row itself — Enter/Space on a nested button/link/checkbox must keep its own meaning.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    };
    return (
      <div
        className="tg-row"
        role={tabbable ? "link" : undefined}
        tabIndex={tabbable ? 0 : undefined}
        onClick={(e) => { if (!clickedInteractive(e)) onClick(); }}
        onKeyDown={tabbable ? onKeyDown : undefined}
        style={{ ...rowStyle, cursor: "pointer" }}
      >
        {children}
      </div>
    );
  }

  return <div style={rowStyle}>{children}</div>;
}
