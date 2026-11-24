"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { BULK_CAPABILITIES, planBulkCapabilities, togglePick, type BulkMode } from "../lib/bulk-capabilities";
import type { BulkCapabilityResult, ServerView } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";

/**
 * Grant or revoke the opt-in capabilities (terminal, files, file changes, swarm) on many selected servers. The
 * dialog is the confirmation: before the button it lists, per server, exactly which capabilities would change,
 * and which servers are skipped and why. The hub re-checks every server (team permission, files_write needs files)
 * and writes one audit entry per server; the result view shows each server's outcome.
 */
export function CapabilitiesBulkModal({ servers, selectedIds, onClose }: { servers: ServerView[]; selectedIds: string[]; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [mode, setMode] = useState<BulkMode>("grant");
  const [picked, setPicked] = useState<string[]>([]);
  const plan = planBulkCapabilities(servers, new Set(selectedIds), mode, picked);
  const affected = plan.filter((r) => r.changes.length > 0);
  const capName = (c: string) => t(`servers.capShort_${c}`);

  const apply = useMutation({
    mutationFn: () => {
      const ids = affected.map((r) => r.id);
      return api.bulkSetServerCapabilities(ids, mode === "grant" ? picked : [], mode === "revoke" ? picked : []);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["servers"] }),
  });
  const results = apply.data?.results;
  const nameOf = (id: string) => servers.find((s) => s.id === id)?.name ?? id;
  const resultLabel = (r: BulkCapabilityResult) => {
    if (r.ok) return r.granted.length + r.revoked.length === 0 ? t("servers.bulkCaps.noChange") : [...r.granted, ...r.revoked].map(capName).join(", ");
    return t(`servers.bulkCaps.err_${r.error}`);
  };

  const rowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--c-bd)" };
  const modeBtn = (m: BulkMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => { setMode(m); setPicked([]); }}
      style={{ fontFamily: "inherit", fontSize: 13, cursor: "pointer", padding: "5px 14px", border: "1px solid var(--c-bd)", background: mode === m ? "var(--c-ad)" : "transparent", color: mode === m ? "var(--c-a)" : "var(--c-tx2)", fontWeight: mode === m ? 600 : 400 }}
    >
      {label}
    </button>
  );

  return (
    <Modal
      ariaLabel={t("servers.bulkCaps.title", { n: selectedIds.length })}
      onClose={onClose}
      zIndex={9000}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "8vh" }}
      cardStyle={{ width: 560, maxWidth: "92vw", background: "var(--c-sb)", padding: 20, maxHeight: "84vh", overflowY: "auto" }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>{t("servers.bulkCaps.title", { n: selectedIds.length })}</h2>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("servers.bulkCaps.hint")}</p>

      {!results ? (
        <>
          <div role="group" aria-label={t("servers.bulkCaps.action")} style={{ display: "inline-flex", marginBottom: 12, borderRadius: 8, overflow: "hidden" }}>
            {modeBtn("grant", t("servers.bulkCaps.grant"))}
            {modeBtn("revoke", t("servers.bulkCaps.revoke"))}
          </div>
          <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
            {BULK_CAPABILITIES.map((c) => (
              <label key={c} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--c-tx2)" }}>
                <input type="checkbox" checked={picked.includes(c)} onChange={() => setPicked((p) => togglePick(p, c, mode))} style={{ marginTop: 2 }} />
                <span>
                  {capName(c)}
                  <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.4 }}>{t(`servers.bulkCaps.desc_${c}`)}</span>
                </span>
              </label>
            ))}
          </div>

          {picked.length > 0 && (
            <div role="region" aria-label={t("servers.bulkCaps.review")} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {t(mode === "grant" ? "servers.bulkCaps.reviewGrant" : "servers.bulkCaps.reviewRevoke", { n: affected.length })}
              </div>
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {plan.map((r) => (
                  <div key={r.id} data-testid="bulk-cap-row" style={rowStyle}>
                    <span style={{ fontWeight: 600 }}>{r.name}</span>
                    <span style={{ color: r.blocked ? "var(--c-am)" : r.changes.length ? "var(--c-tx)" : "var(--c-tx3)" }}>
                      {r.blocked ? t(`servers.bulkCaps.err_${r.blocked}`) : r.changes.length ? r.changes.map(capName).join(", ") : t("servers.bulkCaps.noChange")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Btn variant="ghost" type="button" onClick={onClose}>{t("bulk.close")}</Btn>
            <Btn type="button" onClick={() => apply.mutate()} disabled={apply.isPending || affected.length === 0}>
              {apply.isPending
                ? t("bulk.applying")
                : t(mode === "grant" ? "servers.bulkCaps.confirmGrant" : "servers.bulkCaps.confirmRevoke", { n: affected.length })}
            </Btn>
          </div>
          {apply.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(apply.error as Error)?.message}</div>}
        </>
      ) : (
        <div>
          <div role="status" style={{ fontSize: 13, marginBottom: 12 }}>
            {t("servers.bulkCaps.done", { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length })}
          </div>
          <div style={{ marginBottom: 14, maxHeight: 240, overflowY: "auto" }}>
            {results.map((r) => (
              <div key={r.id} style={rowStyle}>
                <span style={{ fontWeight: 600 }}>{nameOf(r.id)}</span>
                <span style={{ color: r.ok ? "var(--c-g)" : "var(--c-am)" }}>{resultLabel(r)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose}>{t("bulk.close")}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
