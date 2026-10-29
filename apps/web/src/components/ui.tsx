"use client";

import Link from "next/link";
import { ArrowLeft, type LucideIcon } from "lucide-react";
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
  icon: Icon,
  children,
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  // Optional leading lucide icon, rendered before the label (decorative, aria-hidden).
  icon?: LucideIcon;
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
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  };
  const variants: Record<string, CSSProperties> = {
    primary: { background: "var(--c-a)", color: "var(--c-on-a)" },
    ghost: {
      background: "var(--c-el)",
      color: "var(--c-tx)",
      border: "1px solid var(--c-bd)",
    },
    danger: { background: "var(--c-r)", color: "#fff" },
  };
  return (
    <button type={type} style={{ ...base, ...variants[variant], ...style }} {...rest}>
      {Icon && <Icon size={14} aria-hidden style={{ flexShrink: 0 }} />}
      {children}
    </button>
  );
}

export function Card({
  children,
  style,
  id,
}: {
  children: ReactNode;
  style?: CSSProperties;
  id?: string; // optional anchor target (e.g. deep-link #wildcard)
}) {
  return (
    <div
      id={id}
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
      role="img"
      aria-label={status}
      title={status}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: STATUS_COLOR[status],
        // color-mix, not `${color}22`: the colors are CSS vars, so the old `var(--c-r)22` was invalid
        // and the whole box-shadow (the soft halo) was dropped by the browser.
        boxShadow: `0 0 0 3px color-mix(in srgb, ${STATUS_COLOR[status]} 14%, transparent)`,
      }}
    />
  );
}

/** Coloured status dot + label (RUNNING / OFFLINE / SUCCESS …). */
export function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 14%, transparent)` }} />
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

/**
 * Centred placeholder for empty lists/sections. Backward compatible: passing
 * only children renders them as the description (the old behaviour). Add an
 * icon + title + action (CTA) for a friendlier first-run state.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div style={{ padding: "44px 28px", textAlign: "center" }}>
      {Icon && (
        <div style={{ width: 44, height: 44, borderRadius: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
          <Icon size={20} color="var(--c-tx3)" />
        </div>
      )}
      {title && <div style={{ fontSize: 15, fontWeight: 600, color: "var(--c-tx)", marginBottom: 4 }}>{title}</div>}
      {children && <div style={{ fontSize: 13, color: "var(--c-tx3)", maxWidth: 380, margin: "0 auto", lineHeight: 1.5 }}>{children}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
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
