"use client";

import { useState, type ReactNode } from "react";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { Modal } from "../modal";
import { TypedConfirmField } from "../typed-confirm-field";

/** A destructive or irreversible step: the operator types the exact name(s) before the button enables. One input per
 *  name, in order (a takeover approval asks for the target server and the source host). `extra` renders further
 *  controls (data-loss acknowledgement, resource names) and `extraReady` gates the button on them. */
export function TypedConfirmDialog({
  title,
  body,
  names,
  confirmLabel,
  danger = true,
  busy = false,
  extra,
  extraReady = true,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  names: string[];
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  extra?: ReactNode;
  extraReady?: boolean;
  onConfirm: (typed: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState<string[]>(() => names.map(() => ""));
  const matches = names.every((n, i) => (typed[i] ?? "").trim() === n);
  const ready = matches && extraReady && !busy;
  return (
    <Modal onClose={() => !busy && onClose()} ariaLabel={title} width={480} closeOnBackdrop={false}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 8px" }}>{title}</h2>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 14px", lineHeight: 1.5 }}>{body}</p>
      {names.map((n, i) => (
        <TypedConfirmField
          key={n + i}
          autoFocus={i === 0}
          mono
          expected={n}
          value={typed[i] ?? ""}
          onChange={(v) => setTyped((prev) => prev.map((x, j) => (j === i ? v : x)))}
          onEnter={() => { if (ready) onConfirm(typed); }}
          label={t("migrationRun.confirm.typeToConfirm", { name: n })}
          style={{ fontSize: 14 }}
        />
      ))}
      {extra}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={onClose} disabled={busy}>{t("common.cancel")}</Btn>
        <Btn variant={danger ? "danger" : "primary"} disabled={!ready} loading={busy} onClick={() => onConfirm(typed)}>{confirmLabel}</Btn>
      </div>
    </Modal>
  );
}
