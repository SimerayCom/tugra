"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Btn } from "../../../components/ui";
import type { HubBackupView } from "../../../lib/types";

const fieldStyle: React.CSSProperties = { background: "var(--c-bg)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", padding: "6px 8px", font: "inherit", fontSize: 13 };
const note: React.CSSProperties = { fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/** The "keep it somewhere else" nudge shown while the hub backup only lives on this server's own disk. */
export function OffBoxNudge() {
  const t = useT();
  return (
    <div role="note" style={{ fontSize: 12, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "9px 11px", marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ flex: "1 1 240px" }}>{t("settings.hubBackup_offBoxNudge")}</span>
      <Link href="/destinations" style={{ color: "var(--c-ac)", whiteSpace: "nowrap" }}>{t("settings.hubBackup_addDestination")}</Link>
    </div>
  );
}

/** Monthly restore drill: when it last ran, whether it passed, and a button to run it now. */
export function RestoreDrillSection({ data }: { data: HubBackupView }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.runHubDrill(),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["hubBackup"] }); toast(t("settings.hubBackup_drillStarted"), r.status === "SUCCESS" ? "success" : "error"); },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.hubBackup_drillError"), "error"),
  });
  const last = data.drill.last;
  const line = !last
    ? t("settings.hubBackup_drillNever")
    : last.status === "SUCCESS"
      ? t("settings.hubBackup_drillOk", { at: when(last.completedAt ?? last.createdAt), tables: String(last.tables ?? 0) })
      : last.status === "RUNNING"
        ? t("settings.hubBackup_drillRunning")
        : t("settings.hubBackup_drillFailed", { at: when(last.completedAt ?? last.createdAt), reason: (last.errorTail ?? "").split("\n")[0].slice(0, 160) });
  const tone = last?.status === "SUCCESS" ? "var(--c-g)" : last?.status === "FAILED" ? "var(--c-r)" : "var(--c-tx3)";
  return (
    <section aria-label={t("settings.hubBackup_drillTitle")} style={{ marginTop: 18, borderTop: "1px solid var(--c-bd)", paddingTop: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{t("settings.hubBackup_drillTitle")}</div>
      <p style={{ ...note, margin: "4px 0 8px" }}>{t("settings.hubBackup_drillDesc")}</p>
      <div role="status" style={{ fontSize: 12, color: tone }}>{line}</div>
      {data.drill.overdue && <div style={{ ...note, color: "var(--c-am)", marginTop: 4 }}>{t("settings.hubBackup_drillOverdue")}</div>}
      <div style={{ marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => run.mutate()} disabled={run.isPending || data.items.length === 0}>{run.isPending ? t("settings.hubBackup_drillRunning") : t("settings.hubBackup_drillRun")}</Btn>
      </div>
    </section>
  );
}

/** Dead-man check-in: the hub pings an address outside itself on an interval. The address is a secret and is never shown back. */
export function DeadmanSection({ data }: { data: HubBackupView }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const d = data.deadman;
  const [enabled, setEnabled] = useState(d.enabled);
  const [interval, setIntervalMin] = useState(d.intervalMinutes);
  const [url, setUrl] = useState("");
  useEffect(() => { setEnabled(d.enabled); setIntervalMin(d.intervalMinutes); }, [d.enabled, d.intervalMinutes]);

  const save = useMutation({
    mutationFn: () => api.setHubDeadman({ enabled, intervalMinutes: interval, ...(url.trim() ? { url: url.trim() } : {}) }),
    onSuccess: () => { setUrl(""); qc.invalidateQueries({ queryKey: ["hubBackup"] }); toast(t("settings.hubBackup_deadmanSaved"), "success"); },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.hubBackup_deadmanSaveFailed"), "error"),
  });
  const test = useMutation({
    mutationFn: () => api.testHubDeadman(),
    onSuccess: (r) => toast(r.ok ? t("settings.hubBackup_deadmanTestOk") : t("settings.hubBackup_deadmanTestFailed", { reason: r.error ?? String(r.status ?? "") }), r.ok ? "success" : "error"),
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.hubBackup_deadmanSaveFailed"), "error"),
  });
  const id = "hub-deadman-url";
  return (
    <section aria-label={t("settings.hubBackup_deadmanTitle")} style={{ marginTop: 18, borderTop: "1px solid var(--c-bd)", paddingTop: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{t("settings.hubBackup_deadmanTitle")}</div>
      <p style={{ ...note, margin: "4px 0 10px" }}>{t("settings.hubBackup_deadmanDesc")}</p>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("settings.hubBackup_deadmanEnable")}
      </label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label htmlFor={id} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--c-tx3)", flex: "1 1 260px" }}>
          {t("settings.hubBackup_deadmanUrl")}
          <input id={id} style={fieldStyle} type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} placeholder={t("settings.hubBackup_deadmanUrlPlaceholder")} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--c-tx3)" }}>
          {t("settings.hubBackup_deadmanInterval")}
          <input style={{ ...fieldStyle, width: 90 }} type="number" min={1} max={60} value={interval} onChange={(e) => setIntervalMin(Math.min(60, Math.max(1, Number(e.target.value) || 1)))} />
        </label>
      </div>
      {d.urlSet && d.urlHost && <div style={{ ...note, marginTop: 6 }}>{t("settings.hubBackup_deadmanUrlSaved", { host: d.urlHost })}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("settings.hubBackup_deadmanSave")}</Btn>
        <Btn variant="ghost" onClick={() => test.mutate()} disabled={test.isPending || !d.urlSet}>{t("settings.hubBackup_deadmanTest")}</Btn>
      </div>
      <div role="status" style={{ ...note, marginTop: 8, color: d.lastError ? "var(--c-r)" : "var(--c-tx3)" }}>
        {d.lastError ? t("settings.hubBackup_deadmanFailing", { reason: d.lastError }) : d.lastOkAt ? t("settings.hubBackup_deadmanLastOk", { at: when(d.lastOkAt) }) : t("settings.hubBackup_deadmanNever")}
      </div>
    </section>
  );
}
