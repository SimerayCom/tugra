"use client";

import type { ReactNode } from "react";

/**
 * Icon-only button with a required accessible label (was raw `×`/trash buttons
 * with no aria-label). `danger` tints it red for destructive actions.
 */
export function IconBtn({
  label,
  onClick,
  danger,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 34,
        minHeight: 34,
        padding: 6,
        background: "transparent",
        border: "1px solid var(--c-bd)",
        borderRadius: "var(--r1)",
        color: danger ? "var(--c-r)" : "var(--c-tx3)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
        fontSize: 14,
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}
