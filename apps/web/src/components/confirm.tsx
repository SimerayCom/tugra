"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { Modal } from "./modal";

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

  const opts = state?.opts;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <Modal onClose={() => close(false)} zIndex={70}>
          <div style={{ fontWeight: 700, marginBottom: opts?.body ? 8 : 14 }}>{opts?.title ?? t("common.confirmTitle")}</div>
          {opts?.body && <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 14px", lineHeight: 1.5 }}>{opts.body}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => close(false)}>{opts?.cancelLabel ?? t("common.cancel")}</Btn>
            <Btn variant={opts?.danger ? "danger" : "primary"} onClick={() => close(true)}>
              {opts?.confirmLabel ?? t("common.confirm")}
            </Btn>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}
