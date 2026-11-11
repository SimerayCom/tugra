"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react";
import { subscribeToast, emitToast, type ToastType, type ToastAction, type ToastOptions } from "../lib/toast-bus";
import { useT } from "../i18n/provider";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

const COLOR: Record<ToastType, string> = {
  error: "var(--c-r)",
  success: "var(--c-g)",
  // Lapis (not the gold accent) so an info toast never reads like a primary action.
  info: "var(--c-lapis)",
};
const ICON: Record<ToastType, LucideIcon> = {
  error: XCircle,
  success: CheckCircle2,
  info: Info,
};
// Errors linger (easy to miss a flash); success/info clear quickly. Hover/focus pauses either (below).
const TTL: Record<ToastType, number> = {
  error: 10000,
  success: 4000,
  info: 4000,
};

/**
 * Imperative toast: `const toast = useToast(); toast("Saved", "success")`. A third argument can attach an
 * action (e.g. Undo) or override the delay: `toast("Deleted", "info", { action: { label: "Undo", onClick } })`.
 */
export function useToast() {
  return useCallback((message: string, type: ToastType = "info", opts?: ToastOptions) => emitToast(message, type, opts), []);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  // Per-toast auto-dismiss timers plus the bookkeeping to pause/resume them on hover/focus: `remaining`
  // is the ms left, `startAt` is when the running timer began. All cleared on unmount (no leaked timers).
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const remaining = useRef(new Map<number, number>());
  const startAt = useRef(new Map<number, number>());
  const paused = useRef(false);

  const dismiss = useCallback((id: number) => {
    const h = timers.current.get(id);
    if (h) clearTimeout(h);
    timers.current.delete(id);
    remaining.current.delete(id);
    startAt.current.delete(id);
    setToasts((ts) => ts.filter((x) => x.id !== id));
  }, []);

  const startTimer = useCallback(
    (id: number) => {
      const ms = remaining.current.get(id);
      if (ms == null) return;
      startAt.current.set(id, Date.now());
      timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );

  // Pause: stop every running timer and bank how much time each has left.
  const pauseAll = useCallback(() => {
    if (paused.current) return;
    paused.current = true;
    for (const [id, h] of timers.current) {
      clearTimeout(h);
      const left = (remaining.current.get(id) ?? 0) - (Date.now() - (startAt.current.get(id) ?? Date.now()));
      remaining.current.set(id, Math.max(0, left));
    }
    timers.current.clear();
  }, []);

  // Resume: restart a timer for each toast still showing, using its banked remaining time.
  const resumeAll = useCallback(() => {
    if (!paused.current) return;
    paused.current = false;
    for (const id of remaining.current.keys()) {
      if (!timers.current.has(id)) startTimer(id);
    }
  }, [startTimer]);

  useEffect(() => {
    return subscribeToast(({ message, type, action, durationMs }) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts, { id, message, type, action }]);
      remaining.current.set(id, durationMs ?? TTL[type]);
      // A toast arriving while the stack is hovered/focused waits (banked), so it isn't missed.
      if (!paused.current) startTimer(id);
    });
  }, [startTimer]);

  // Clear every pending timer when the provider unmounts.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const h of map.values()) clearTimeout(h);
      map.clear();
    };
  }, []);

  return (
    <>
      {children}
      <div
        // Persistent live region: it exists before any toast mounts, so screen readers reliably
        // announce insertions (a live region created together with its content is often missed).
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: "fixed",
          // Bottom placement keeps toasts clear of the header controls; left+right+maxWidth hugs the right
          // on desktop and shrinks to a safe-area-inset gutter on phones (no media query needed).
          bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
          left: "calc(16px + env(safe-area-inset-left, 0px))",
          right: "calc(16px + env(safe-area-inset-right, 0px))",
          zIndex: 100,
          display: "flex",
          justifyContent: "flex-end",
          pointerEvents: "none",
        }}
      >
        <div
          // Hovering or focusing anywhere in the stack pauses auto-dismiss so a toast can be read or acted
          // on; leaving/blurring resumes it. Handlers live here (the stack has pointer events; the live
          // region above is click-through) so moving between stacked toasts never flickers pause state.
          onMouseEnter={pauseAll}
          onMouseLeave={resumeAll}
          onFocus={pauseAll}
          onBlur={resumeAll}
          data-testid="toast-stack"
          style={{ pointerEvents: "auto", display: "flex", flexDirection: "column", gap: 8, width: "100%", maxWidth: 360 }}
        >
          {toasts.map((toast) => {
            const TypeIcon = ICON[toast.type];
            return (
              <div
                key={toast.id}
                // The container above is the polite live region; errors escalate to an assertive alert.
                // No per-toast aria-live, to avoid a nested live region double-announcing.
                role={toast.type === "error" ? "alert" : undefined}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  background: "var(--c-sb)",
                  border: "1px solid var(--c-bd)",
                  borderLeft: `3px solid ${COLOR[toast.type]}`,
                  borderRadius: "var(--r1)",
                  padding: "10px 12px",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                  fontSize: 13,
                  color: "var(--c-tx)",
                }}
              >
                <TypeIcon size={16} aria-hidden style={{ color: COLOR[toast.type], flexShrink: 0, marginTop: 1 }} />
                <span style={{ flex: 1, wordBreak: "break-word", paddingTop: 1 }}>{toast.message}</span>
                {toast.action && (
                  <button
                    onClick={() => {
                      toast.action!.onClick();
                      dismiss(toast.id);
                    }}
                    style={{
                      flexShrink: 0,
                      background: "transparent",
                      border: "none",
                      color: COLOR[toast.type],
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 13,
                      fontWeight: 600,
                      padding: "0 4px",
                      minHeight: 32,
                    }}
                  >
                    {toast.action.label}
                  </button>
                )}
                <button
                  onClick={() => dismiss(toast.id)}
                  aria-label={t("common.dismiss")}
                  style={{
                    flexShrink: 0,
                    background: "transparent",
                    border: "none",
                    color: "var(--c-tx3)",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    // 32px touch target (the glyph stays 15px); negative margin keeps the padded hit area
                    // from inflating the toast's height/edges.
                    minWidth: 32,
                    minHeight: 32,
                    margin: "-6px -6px -6px 0",
                    padding: 0,
                    fontFamily: "inherit",
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
