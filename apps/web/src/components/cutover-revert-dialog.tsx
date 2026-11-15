"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { Btn } from "./ui";
import { Modal } from "./modal";

/** Revert flipped hosts to their pre-flip DNS. The records are restored exactly; data written on Tugra after the
 *  flip is NOT carried back, so the owner must acknowledge that before the button enables. */
export function CutoverRevertDialog({ opId, hostnames, onClose }: { opId: string; hostnames: string[]; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [ack, setAck] = useState(false);
  const [force, setForce] = useState(false);
  const revert = useMutation({
    mutationFn: () => api.cutoverRevert(opId, { hostnames, ...(force ? { force: true } : {}), acknowledgeDataLoss: true }),
    onSuccess: (view) => {
      qc.setQueryData(["cutover", opId], view);
      toast(t("cutover.revert.done"), "success");
      onClose();
    },
  });
  return (
    <Modal onClose={onClose} width={520} labelledBy="cutover-revert-title" closeOnBackdrop={!revert.isPending}>
      <h2 id="cutover-revert-title" style={{ fontSize: 15, fontWeight: 700, margin: "0 0 8px" }}>{t("cutover.revert.title")}</h2>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 8px", lineHeight: 1.5 }}>{t("cutover.revert.hosts", { count: hostnames.length })}</p>
      <ul className="mono" style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)", maxHeight: 120, overflowY: "auto", wordBreak: "break-all" }}>
        {hostnames.map((h) => <li key={h}>{h}</li>)}
      </ul>
      <p style={{ fontSize: 13, color: "var(--c-am)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("cutover.revert.dataLoss")}</p>
      <label style={checkRow}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={box} />
        <span>{t("cutover.revert.ackDataLoss")}</span>
      </label>
      <label style={checkRow}>
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={box} />
        <span>{t("cutover.revert.force")}</span>
      </label>
      {revert.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 10 }}>{(revert.error as Error).message}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={onClose} disabled={revert.isPending}>{t("common.cancel")}</Btn>
        <Btn variant="danger" onClick={() => revert.mutate()} disabled={!ack || hostnames.length === 0 || revert.isPending} loading={revert.isPending}>
          {t("cutover.action.revert")}
        </Btn>
      </div>
    </Modal>
  );
}

const checkRow: React.CSSProperties = { display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12, fontSize: 13, color: "var(--c-tx2)", cursor: "pointer", lineHeight: 1.5 };
const box: React.CSSProperties = { marginTop: 2, accentColor: "var(--c-a)", flexShrink: 0 };
