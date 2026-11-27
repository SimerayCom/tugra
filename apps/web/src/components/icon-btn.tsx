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
  pressed,
  loading,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  // When set, the button is a toggle: `aria-pressed` is exposed and the "on" state
  // is shown with the accent chrome (so a reveal/bulk toggle reads as a toggle, not a one-shot).
  pressed?: boolean;
  // The call this button starts is running: a small spinner replaces the icon, the button is aria-busy and disabled (no double submit).
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      title={label}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className="tg-iconbtn"
      data-danger={danger ? "" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 6,
        // min size (34px, 44px on touch) + background / border / colour (rest, hover, active, pressed) live in .tg-iconbtn (CSS).
        borderRadius: "var(--r1)",
        cursor: disabled || loading ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
        fontSize: 14,
        lineHeight: 1,
      }}
    >
      {loading ? (
        <span aria-hidden style={{ width: 14, height: 14, flexShrink: 0, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite", opacity: 0.85 }} />
      ) : (
        children
      )}
    </button>
  );
}
