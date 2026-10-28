"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react";
import { subscribeToast, emitToast, type ToastType } from "../lib/toast-bus";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

const COLOR: Record<ToastType, string> = {
  error: "var(--c-r)",
  success: "var(--c-g)",
  info: "var(--c-a)",
};
const ICON: Record<ToastType, LucideIcon> = {
  error: XCircle,
  success: CheckCircle2,
  info: Info,
};
const TTL = 4000;

/** Imperative toast: `const toast = useToast(); toast("Saved", "success")`. */
export function useToast() {
  return useCallback((message: string, type: ToastType = "info") => emitToast(message, type), []);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  useEffect(() => {
    return subscribeToast(({ message, type }) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts, { id, message, type }]);
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TTL);
    });
  }, []);

  return (
    <>
      {children}
      <div
        style={{ position: "fixed", top: 16, right: 16, zIndex: 100, display: "flex", flexDirection: "column", gap: 8, maxWidth: 360, pointerEvents: "none" }}
      >
        {toasts.map((t) => {
          const TypeIcon = ICON[t.type];
          return (
          <div
            key={t.id}
            role={t.type === "error" ? "alert" : "status"}
            aria-live={t.type === "error" ? "assertive" : "polite"}
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              background: "var(--c-sb)",
              border: "1px solid var(--c-bd)",
              borderLeft: `3px solid ${COLOR[t.type]}`,
              borderRadius: "var(--r1)",
              padding: "10px 12px",
              boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
              fontSize: 13,
              color: "var(--c-tx)",
            }}
          >
            <TypeIcon size={16} aria-hidden style={{ color: COLOR[t.type], flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1, wordBreak: "break-word" }}>{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", display: "inline-flex", alignItems: "center", lineHeight: 1, padding: 0, fontFamily: "inherit" }}
            >
              <X size={14} />
            </button>
          </div>
          );
        })}
      </div>
    </>
  );
}
