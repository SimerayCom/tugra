"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { StatusPill } from "./ui";

/** Detail-page header: breadcrumb + title + status + actions, with an optional meta row. */
export function PageHeader({
  breadcrumb,
  title,
  status,
  badge,
  actions,
  children,
}: {
  breadcrumb?: { label: string; href?: string }[];
  title: ReactNode;
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
                  <Link href={b.href} style={{ fontSize: 12, color: "var(--c-tx3)", textDecoration: "none" }}>
                    {b.label}
                  </Link>
                ) : (
                  <span style={{ fontSize: 12, color: last ? "var(--c-tx2)" : "var(--c-tx3)" }}>{b.label}</span>
                )}
                {!last && <ChevronRight size={13} color="var(--c-tx3)" />}
              </span>
            );
          })}
        </nav>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
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
