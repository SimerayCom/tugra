"use client";

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { ServerStatus } from "../lib/types";

export function Btn({
  variant = "primary",
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
    <button style={{ ...base, ...variants[variant], ...style }} {...rest}>
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
