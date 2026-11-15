"use client";

import { useState } from "react";
import { useT } from "../../../i18n/provider";
import { Btn } from "../../../components/ui";
import { Modal } from "../../../components/modal";

/** File-name-safe slug of a destination name. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "destination";
}

/**
 * Shows a destination's one-time recovery key. The key lives ONLY in this component's props/state: it is never
 * written to localStorage / sessionStorage or the query cache, and the parent clears it when the dialog closes.
 * "Done" needs the explicit "I saved it offline" tick; "skip for now" closes without it.
 */
export function RecoveryKeyDialog({ name, recoveryKey, onClose }: { name: string; recoveryKey: string; onClose: () => void }) {
  const t = useT();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch {
      /* clipboard unavailable — the key is selectable on screen */
    }
  };
  const download = () => {
    const blob = new Blob([t("destinations.recoveryKey_file", { name, key: recoveryKey })], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tugra-destination-${slugify(name)}-recovery-key.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal onClose={() => undefined} closeOnEsc={false} closeOnBackdrop={false} width={520} ariaLabel={t("destinations.recoveryKey_title")}
      cardStyle={{ width: "100%", maxWidth: 520 }}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{t("destinations.recoveryKey_title")}</div>
        <p style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5, margin: 0 }}>{t("destinations.recoveryKey_body", { name })}</p>
        <div>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 4 }}>{t("destinations.recoveryKey_label")}</div>
          <code className="mono" data-testid="recovery-key" style={{ display: "block", padding: "10px 12px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", fontSize: 13, wordBreak: "break-all", userSelect: "all" }}>
            {recoveryKey}
          </code>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={copy}>{copied ? t("destinations.recoveryKey_copied") : t("destinations.recoveryKey_copy")}</Btn>
          <Btn variant="ghost" onClick={download}>{t("destinations.recoveryKey_download")}</Btn>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {t("destinations.recoveryKey_saved")}
        </label>
        <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--c-tx3)", fontSize: 12, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
            {t("destinations.recoveryKey_skip")}
          </button>
          <Btn onClick={onClose} disabled={!saved}>{t("destinations.recoveryKey_done")}</Btn>
        </div>
      </div>
    </Modal>
  );
}
