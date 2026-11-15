"use client";

import { useState } from "react";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { Modal } from "../modal";

/**
 * The final pass is destructive in two ways, each with its OWN acknowledgement: (1) writes to the source after this pass are
 * not copied (REQUIRED, the start button stays disabled without it), (2) `--remove` deletes destination objects that are not on
 * the source (separate, off by default).
 */
export function FreezeAckDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: (opts: { removeExtraneous: boolean }) => void }) {
  const t = useT();
  const [frozen, setFrozen] = useState(false);
  const [remove, setRemove] = useState(false);
  return (
    <Modal onClose={onCancel} labelledBy="om-freeze-title" width={520}>
      <div style={{ padding: 20 }}>
        <h2 id="om-freeze-title" style={{ fontSize: 16, fontWeight: 600, margin: "0 0 8px" }}>{t("objectMigration.freeze.title")}</h2>
        <p style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5, margin: "0 0 14px" }}>{t("objectMigration.freeze.body")}</p>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, marginBottom: 12 }}>
          <input type="checkbox" checked={frozen} onChange={(e) => setFrozen(e.target.checked)} style={{ marginTop: 3 }} />
          {t("objectMigration.freeze.confirm")}
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
          <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} style={{ marginTop: 3 }} />
          {t("objectMigration.freeze.removeExtraneous")}
        </label>
        {remove && <p role="alert" style={{ fontSize: 12, color: "var(--c-r)", margin: "6px 0 0 24px" }}>{t("objectMigration.freeze.removeWarning")}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <Btn variant="ghost" onClick={onCancel} disabled={busy}>{t("objectMigration.phase.cancel")}</Btn>
          <Btn onClick={() => onConfirm({ removeExtraneous: remove })} disabled={!frozen || busy}>{t("objectMigration.freeze.start")}</Btn>
        </div>
      </div>
    </Modal>
  );
}
