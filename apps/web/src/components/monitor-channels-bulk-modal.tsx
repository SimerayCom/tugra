"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { bulkSummary } from "../lib/bulk";
import { teamLabel } from "../lib/fleet";
import { useT } from "../i18n/provider";
import type { Monitor } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";

/** Set the same notification channels on many selected monitors (fleet alert op). */
export function MonitorChannelsBulkModal({
  monitors,
  selectedIds,
  onClose,
}: {
  monitors: Monitor[];
  selectedIds: string[];
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const sum = bulkSummary(monitors, new Set(selectedIds));

  const toggle = (id: string) =>
    setChannelIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const apply = useMutation({
    mutationFn: () => api.bulkSetMonitorChannels(selectedIds, channelIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["monitors"] }),
  });
  const result = apply.data;

  return (
    <Modal
      onClose={onClose}
      zIndex={9000}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "10vh" }}
      cardStyle={{ width: 540, maxWidth: "92vw", background: "var(--c-sb)", padding: 20, maxHeight: "76vh", overflowY: "auto" }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>{t("bulk.channelsTitle", { n: selectedIds.length })}</h2>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("bulk.channelsHint")}</p>

      {!result ? (
        <form onSubmit={(e) => { e.preventDefault(); apply.mutate(); }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("bulk.pickChannels")}</div>
          {channels.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--c-tx3)", marginBottom: 14 }}>{t("monitors.channelsEmpty")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
              {channels.map((c) => (
                <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)" }}>
                  <input type="checkbox" checked={channelIds.includes(c.id)} onChange={() => toggle(c.id)} />
                  {c.name}
                  {teams.length > 1 && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>· {teamLabel(teams, c.teamId)}</span>}
                </label>
              ))}
            </div>
          )}
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 14 }}>
            {t("bulk.summary", { writable: sum.writable, skipped: sum.skipped })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" type="button" onClick={onClose}>{t("bulk.close")}</Btn>
            <Btn type="submit" disabled={apply.isPending || sum.writable === 0 || channelIds.length === 0}>{apply.isPending ? "…" : t("bulk.applyChannels")}</Btn>
          </div>
          {apply.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(apply.error as Error).message}</div>}
        </form>
      ) : (
        <div>
          <div style={{ fontSize: 13, marginBottom: 14 }}>{t("bulk.channelsResult", { applied: result.applied.length, skipped: result.skipped.length })}</div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose}>{t("bulk.close")}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
