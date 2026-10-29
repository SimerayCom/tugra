"use client";

import { useState } from "react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { Modal } from "./modal";

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
    <Modal onClose={onClose} ariaLabel={title}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>{title}</div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSave(name.trim()); }}
        style={{ width: "100%", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 14, fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn onClick={() => onSave(name.trim())} disabled={pending || !name.trim()}>{t("common.save")}</Btn>
      </div>
    </Modal>
  );
}
