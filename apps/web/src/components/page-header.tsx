"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { StatusPill } from "./ui";

/** Detail-page header: breadcrumb + title + status + actions, with an optional meta row. */
export function PageHeader({
  breadcrumb,
  title,
  icon,
  status,
  badge,
  actions,
  children,
}: {
  breadcrumb?: { label: string; href?: string }[];
  title: ReactNode;
  icon?: ReactNode;
  status?: { label: string; color: string };
  badge?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      {breadcrumb && breadcrumb.length > 0 && (
        <nav style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
          {breadcrumb.map((b, i) => {
            const last = i === breadcrumb.length - 1;
            return (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {b.href && !last ? (
                  <Link href={b.href} className="tg-link" style={{ fontSize: 12 }}>
                    {b.label}
                  </Link>
                ) : (
                  <span aria-current={last ? "page" : undefined} style={{ fontSize: 12, color: last ? "var(--c-tx2)" : "var(--c-tx3)" }}>{b.label}</span>
                )}
                {!last && <ChevronRight size={13} color="var(--c-tx3)" />}
              </span>
            );
          })}
        </nav>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {icon && (
          <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--c-tile)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {icon}
          </span>
        )}
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{title}</h1>
        {status && <StatusPill label={status.label} color={status.color} />}
        {badge}
        <div style={{ flex: 1, minWidth: 12 }} />
        {actions && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>}
      </div>
      {children && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

/**
 * List/index-page title block: h1 + optional subtitle on the left, an optional right-aligned actions
 * slot (primary "New X" button etc.). Sibling of PageHeader (the detail-page header) — same h1 weight,
 * so every top-level page opens the same way. Wraps on narrow screens instead of squeezing the title.
 */
export function PageTitle({
  title,
  subtitle,
  actions,
  style,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 22, ...style }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: subtitle ? "0 0 4px" : 0 }}>{title}</h1>
        {subtitle && <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: 0 }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}
