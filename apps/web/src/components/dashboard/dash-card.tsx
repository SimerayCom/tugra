"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useT } from "../../i18n/provider";

export const sectionTitle: CSSProperties = {
  fontSize: 11, color: "var(--c-tx3)", margin: 0, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.06em",
};

/** One dashboard card: an accessible section with its title row (title left, optional controls / "See all" right). */
export function DashCard({ id, title, right, children, style }: { id: string; title: string; right?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  const headingId = `dash-card-${id}`;
  return (
    <section aria-labelledby={headingId} data-card={id} style={{ marginBottom: 28, ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px", minHeight: 20, flexWrap: "wrap" }}>
        <h2 id={headingId} style={sectionTitle}>{title}</h2>
        <div style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </section>
  );
}

const linkStyle: CSSProperties = { fontSize: 11, color: "var(--c-lapis)", textDecoration: "none", fontWeight: 500, textTransform: "none", letterSpacing: 0 };

/** "See all (27) →" — only when there is more than the card shows. */
export function SeeAll({ href, total, shown }: { href: string; total: number; shown: number }) {
  const t = useT();
  if (total <= shown) return null;
  return <Link href={href} style={linkStyle}>{t("dashboard.seeAll", { n: total })}</Link>;
}

/** A plain text link in a card's title row (e.g. "View all →"). */
export function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} style={linkStyle}>{children}</Link>;
}

/** A muted one-line message that keeps a card at a steady height (empty / nothing-to-report states). */
export function CardNote({ children, role = "status" }: { children: ReactNode; role?: "status" | "alert" }) {
  return (
    <div role={role} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", padding: "14px 16px", fontSize: 13, color: "var(--c-tx3)" }}>
      {children}
    </div>
  );
}
