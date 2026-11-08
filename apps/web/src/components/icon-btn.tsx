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
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  // When set, the button is a toggle: `aria-pressed` is exposed and the "on" state
  // is shown with the accent chrome (so a reveal/bulk toggle reads as a toggle, not a one-shot).
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="tg-iconbtn"
      data-danger={danger ? "" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 6,
        // min size (34px, 44px on touch) + background / border / colour (rest, hover, active, pressed) live in .tg-iconbtn (CSS).
        borderRadius: "var(--r1)",
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
