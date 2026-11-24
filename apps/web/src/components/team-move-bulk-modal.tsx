"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import type { BulkTransferResult } from "../lib/server-transfer";
import type { ServerView } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";

/**
 * Move the selected servers to another team in one go. The hub re-checks every server (rights in both teams,
 * resources of the old team still on it) and answers per server, so a blocked server never stops the others.
 */
export function TeamMoveBulkModal({ servers, selectedIds, onClose }: { servers: ServerView[]; selectedIds: string[]; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [teamId, setTeamId] = useState("");
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const picked = servers.filter((s) => selectedIds.includes(s.id));
  const moving = teamId ? picked.filter((s) => s.canWrite !== false && s.teamId !== teamId) : [];

  const apply = useMutation({
    mutationFn: () => api.changeServersTeam(moving.map((s) => s.id), teamId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["fleet"] });
    },
  });
  const results = apply.data?.results;
  const nameOf = (id: string) => servers.find((s) => s.id === id)?.name ?? id;
  const resultLabel = (r: BulkTransferResult) =>
    r.status === "blocked" && r.blockers?.length
      ? t("servers.teamMoveBulk.blockedBy", { what: r.blockers.map((b) => t(`servers.teamMoveBulk.kind_${b.kind}`, { n: b.count })).join(", ") })
      : t(`servers.teamMoveBulk.status_${r.status}`);
  const rowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--c-bd)" };

  return (
    <Modal
      ariaLabel={t("servers.teamMoveBulk.title", { n: selectedIds.length })}
      onClose={onClose}
      zIndex={9000}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "8vh" }}
      cardStyle={{ width: 520, maxWidth: "92vw", background: "var(--c-sb)", padding: 20, maxHeight: "84vh", overflowY: "auto" }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>{t("servers.teamMoveBulk.title", { n: selectedIds.length })}</h2>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("servers.teamMoveBulk.hint")}</p>

      {!results ? (
        <>
          <label style={{ display: "grid", gap: 6, fontSize: 13, marginBottom: 14 }}>
            {t("servers.teamMoveSelectLabel")}
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} style={{ fontFamily: "inherit", fontSize: 14, padding: "8px 10px", minHeight: 44, background: "var(--c-bg)", color: "var(--c-tx)", border: "1px solid var(--c-bd)", borderRadius: 8 }}>
              <option value="">{t("servers.teamMoveSelectPlaceholder")}</option>
              {teams.map((tm) => (
                <option key={tm.id} value={tm.id}>{tm.name}</option>
              ))}
            </select>
          </label>
          {teamId && (
            <div role="region" aria-label={t("servers.teamMoveBulk.review")} style={{ marginBottom: 14, maxHeight: 220, overflowY: "auto" }}>
              {picked.map((s) => (
                <div key={s.id} data-testid="team-move-row" style={rowStyle}>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                  <span style={{ color: "var(--c-tx3)" }}>{s.canWrite === false ? t("servers.teamMoveBulk.status_denied") : s.teamId === teamId ? t("servers.teamMoveBulk.already") : t("servers.teamMoveBulk.willMove")}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Btn variant="ghost" type="button" onClick={onClose}>{t("bulk.close")}</Btn>
            <Btn type="button" onClick={() => apply.mutate()} disabled={!teamId || moving.length === 0 || apply.isPending}>
              {apply.isPending ? t("bulk.applying") : t("servers.teamMoveBulk.confirm", { n: moving.length })}
            </Btn>
          </div>
          {apply.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(apply.error as Error)?.message}</div>}
        </>
      ) : (
        <div>
          <div role="status" style={{ fontSize: 13, marginBottom: 12 }}>
            {t("servers.teamMoveBulk.done", { ok: apply.data?.moved ?? 0, total: results.length })}
          </div>
          <div style={{ marginBottom: 14, maxHeight: 240, overflowY: "auto" }}>
            {results.map((r) => (
              <div key={r.serverId} style={rowStyle}>
                <span style={{ fontWeight: 600 }}>{nameOf(r.serverId)}</span>
                <span style={{ color: r.status === "moved" ? "var(--c-g)" : r.status === "unchanged" ? "var(--c-tx3)" : "var(--c-am)" }}>{resultLabel(r)}</span>
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
