"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";

export interface ConfirmOptions {
  title?: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Imperative confirmation dialog: `const confirm = useConfirm(); if (await confirm({...})) …`. */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm must be used within ConfirmProvider");
  return fn;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);

  const confirm = useCallback<ConfirmFn>((opts = {}) => {
    return new Promise<boolean>((resolve) => setState({ opts, resolve }));
  }, []);

  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const opts = state?.opts;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div
          onClick={() => close(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--c-bg)", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", padding: 18, minWidth: 320, maxWidth: 440 }}
          >
            <div style={{ fontWeight: 700, marginBottom: opts?.body ? 8 : 14 }}>{opts?.title ?? t("common.confirmTitle")}</div>
            {opts?.body && <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 14px", lineHeight: 1.5 }}>{opts.body}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="ghost" onClick={() => close(false)}>{opts?.cancelLabel ?? t("common.cancel")}</Btn>
              <Btn autoFocus variant={opts?.danger ? "danger" : "primary"} onClick={() => close(true)}>
                {opts?.confirmLabel ?? t("common.confirm")}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
