"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal shell: role=dialog + aria-modal, backdrop/ESC close, Tab focus-trap,
 * initial focus on the first focusable element, and focus restore on unmount.
 */
export function Modal({
  onClose,
  children,
  width = 440,
  zIndex = 50,
  labelledBy,
  ariaLabel,
  cardStyle: cardStyleOverride,
  backdropStyle: backdropStyleOverride,
  closeOnEsc = true,
  trapTab = true,
}: {
  onClose: () => void;
  children: ReactNode;
  width?: number;
  zIndex?: number;
  labelledBy?: string;
  /** Accessible name when there's no visible title element to point `labelledBy` at. */
  ariaLabel?: string;
  cardStyle?: CSSProperties;
  backdropStyle?: CSSProperties;
  closeOnEsc?: boolean;
  trapTab?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = cardRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(card?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    (focusables()[0] ?? card)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (closeOnEsc && e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (trapTab && e.key === "Tab") {
        const f = focusables();
        if (f.length === 0) {
          e.preventDefault();
          return;
        }
        const first = f[0];
        const last = f[f.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !card?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose, closeOnEsc, trapTab]);

  const backdrop: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex,
    padding: 16, // keep the card off the screen edges (mobile gutter)
    ...backdropStyleOverride,
  };
  const cardStyle: CSSProperties = {
    background: "var(--c-bg)",
    border: "1px solid var(--c-bd)",
    borderRadius: "var(--r2)",
    padding: 18,
    minWidth: 0, // let the card shrink below content width on small screens instead of overflowing
    maxWidth: width,
    maxHeight: "90vh", // tall content scrolls inside the card instead of off-screen
    overflowY: "auto",
    ...cardStyleOverride,
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={backdrop}
    >
      <div ref={cardRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-label={ariaLabel} tabIndex={-1} style={cardStyle}>
        {children}
      </div>
    </div>
  );
}
