"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { Modal } from "./modal";
import { fieldStyle } from "./form";

export interface ConfirmOptions {
  title?: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * When set, the confirm button stays disabled until the user types this exact string
   * (e.g. the resource name). A typed-name guard for irreversible, data-destroying actions.
   */
  confirmText?: string;
  /**
   * Optional extra opt-in(s) (e.g. "Keep volumes", "Also remove images"). The dialog renders a checkbox per
   * entry and writes its state to that entry's `ref.current`, so the caller reads each choice from its ref
   * after `confirm()` resolves (a stable ref avoids the stale-closure a captured state value would hit inside
   * the async handler). Pass a single object or an array. The confirm return stays a plain boolean.
   */
  checkbox?: ConfirmCheckboxOpt | ConfirmCheckboxOpt[];
}

export interface ConfirmCheckboxOpt {
  label: string;
  ref: { current: boolean };
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
  const [typed, setTyped] = useState("");

  const confirm = useCallback<ConfirmFn>((opts = {}) => {
    setTyped("");
    return new Promise<boolean>((resolve) => setState({ opts, resolve }));
  }, []);

  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
    setTyped("");
  };

  const opts = state?.opts;
  const needsText = !!opts?.confirmText;
  const canConfirm = !needsText || typed === opts!.confirmText;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <Modal onClose={() => close(false)} zIndex={70} ariaLabel={opts?.title ?? t("common.confirmTitle")}>
          <div style={{ fontWeight: 700, marginBottom: opts?.body ? 8 : 14 }}>{opts?.title ?? t("common.confirmTitle")}</div>
          {opts?.body && <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 14px", lineHeight: 1.5 }}>{opts.body}</p>}
          {needsText && (
            <label style={{ display: "block", marginBottom: 14 }}>
              <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6, lineHeight: 1.5 }}>
                {t("common.typeToConfirm", { text: opts!.confirmText! })}
              </span>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canConfirm) close(true); }}
                aria-label={t("common.typeToConfirm", { text: opts!.confirmText! })}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                style={fieldStyle}
              />
            </label>
          )}
          {opts?.checkbox &&
            (Array.isArray(opts.checkbox) ? opts.checkbox : [opts.checkbox]).map((box, i) => (
              <ConfirmCheckbox key={i} label={box.label} boxRef={box.ref} />
            ))}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => close(false)}>{opts?.cancelLabel ?? t("common.cancel")}</Btn>
            <Btn variant={opts?.danger ? "danger" : "primary"} disabled={!canConfirm} onClick={() => close(true)}>
              {opts?.confirmLabel ?? t("common.confirm")}
            </Btn>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

/** One opt-in checkbox in the confirm dialog. Self-managing: it seeds its state from `boxRef.current` on
 *  mount (the modal remounts each open, so this re-reads the caller's reset value) and mirrors every change
 *  back to the ref, which is the caller's source of truth. */
function ConfirmCheckbox({ label, boxRef }: { label: string; boxRef: { current: boolean } }) {
  const [on, setOn] = useState(boxRef.current);
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 14, fontSize: 13, color: "var(--c-tx2)", cursor: "pointer", lineHeight: 1.5 }}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => { setOn(e.target.checked); boxRef.current = e.target.checked; }}
        style={{ marginTop: 2, accentColor: "var(--c-a)", flexShrink: 0 }}
      />
      <span>{label}</span>
    </label>
  );
}
