"use client";

import { useState } from "react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";

/** Small modal to rename a resource (display name only). */
export function RenameModal({
  current,
  title,
  onClose,
  onSave,
  pending,
}: {
  current: string;
  title: string;
  onClose: () => void;
  onSave: (name: string) => void;
  pending?: boolean;
}) {
  const t = useT();
  const [name, setName] = useState(current);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--c-bg)", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", padding: 18, minWidth: 320 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>{title}</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSave(name.trim()); }}
          style={{ width: "100%", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 14, fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
          <Btn onClick={() => onSave(name.trim())} disabled={pending || !name.trim()}>{t("common.save")}</Btn>
        </div>
      </div>
    </div>
  );
}
