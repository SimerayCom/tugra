"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { ServerStatus } from "../lib/types";

/** Back-to-list link for detail pages (sub-routes have no other way back). */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--c-tx3)", fontSize: 13, textDecoration: "none", marginBottom: 14 }}
    >
      <ArrowLeft size={15} /> {label}
    </Link>
  );
}

export function Btn({
  variant = "primary",
  // Default to "button" so a <Btn onClick> inside a <form> doesn't ALSO submit
  // the form (that double-fired mutations). Submit buttons pass type="submit".
  type = "button",
  children,
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  const base: CSSProperties = {
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: 600,
    padding: "8px 14px",
    borderRadius: "var(--r1)",
    cursor: rest.disabled ? "not-allowed" : "pointer",
    opacity: rest.disabled ? 0.5 : 1,
    border: "1px solid transparent",
    transition: "filter .15s",
  };
  const variants: Record<string, CSSProperties> = {
    primary: { background: "var(--c-a)", color: "#0d0d11" },
    ghost: {
      background: "var(--c-el)",
      color: "var(--c-tx)",
      border: "1px solid var(--c-bd)",
    },
    danger: { background: "var(--c-r)", color: "#fff" },
  };
  return (
    <button type={type} style={{ ...base, ...variants[variant], ...style }} {...rest}>
      {children}
    </button>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--c-sb)",
        border: "1px solid var(--c-bd)",
        borderRadius: "var(--r2)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <div
      style={{
        width: 18,
        height: 18,
        border: "2px solid var(--c-bd)",
        borderTopColor: "var(--c-a)",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }}
    >
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

const STATUS_COLOR: Record<ServerStatus, string> = {
  ONLINE: "var(--c-g)",
  PENDING: "var(--c-am)",
  OFFLINE: "var(--c-r)",
};

export function StatusDot({ status }: { status: ServerStatus }) {
  return (
    <span
      title={status}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: STATUS_COLOR[status],
        boxShadow: `0 0 0 3px ${STATUS_COLOR[status]}22`,
      }}
    />
  );
}

/** Coloured status dot + label (RUNNING / OFFLINE / SUCCESS …). */
export function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 0 3px ${color}22` }} />
      {label}
    </span>
  );
}

/** Card with a consistent uppercase title + optional description and right slot. */
export function SectionCard({
  title,
  desc,
  right,
  children,
  style,
}: {
  title?: string;
  desc?: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <Card style={{ padding: 16, marginBottom: 16, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: desc ? 4 : 12 }}>
          {title && (
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", flex: 1 }}>
              {title}
            </div>
          )}
          {right}
        </div>
      )}
      {desc && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{desc}</p>}
      {children}
    </Card>
  );
}

/** Centred placeholder for empty lists/sections. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 28, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{children}</div>
  );
}

export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "gold" | "lapis";
}) {
  const tones: Record<string, CSSProperties> = {
    muted: { background: "var(--c-el)", color: "var(--c-tx3)" },
    gold: { background: "var(--c-ad)", color: "var(--c-a)" },
    lapis: { background: "rgba(61,111,229,0.15)", color: "var(--c-lapis)" },
  };
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        padding: "2px 7px",
        borderRadius: 6,
        textTransform: "uppercase",
        ...tones[tone],
      }}
    >
      {children}
    </span>
  );
}
