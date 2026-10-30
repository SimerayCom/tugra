"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Btn, Card } from "../../../components/ui";

/**
 * Owner-only scheduled backup of the HUB's OWN Postgres (control-plane DB). Runs on the local agent, always
 * gpg-encrypted with a key derived from SECRETS_ENCRYPTION_KEY — so the warning that the .env must be kept
 * offsite is load-bearing, not decorative.
 */
export function HubBackupCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  const { data } = useQuery({ queryKey: ["hubBackup"], queryFn: () => api.getHubBackup(), enabled: isOwner, refetchOnWindowFocus: false });
  const { data: destinations } = useQuery({ queryKey: ["destinations"], queryFn: () => api.listDestinations(), enabled: isOwner, refetchOnWindowFocus: false });

  const [enabled, setEnabled] = useState(false);
  const [intervalHours, setIntervalHours] = useState(24);
  const [retention, setRetention] = useState(7);
  const [destinationId, setDestinationId] = useState<string>("");
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setIntervalHours(data.intervalHours);
    setRetention(data.retention);
    setDestinationId(data.destinationId ?? "");
  }, [data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["hubBackup"] });
  const save = useMutation({
    mutationFn: () => api.setHubBackup({ enabled, intervalHours, retention, destinationId: destinationId || null }),
    onSuccess: () => { invalidate(); toast(t("settings.hubBackup_saved"), "success"); },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.hubBackup_saveFailed"), "error"),
  });
  const run = useMutation({
    mutationFn: () => api.runHubBackup(),
    onSuccess: (r) => { invalidate(); toast(r.status === "SUCCESS" ? t("settings.hubBackup_runOk") : t("settings.hubBackup_runStarted"), r.status === "FAILED" ? "error" : "success"); },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.hubBackup_runFailed"), "error"),
  });

  if (!isOwner) return null;

  const warn = (msg: string) => (
    <div style={{ fontSize: 12, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "9px 11px", marginTop: 12 }}>{msg}</div>
  );
  const fieldStyle: React.CSSProperties = { background: "var(--c-bg)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", padding: "6px 8px", font: "inherit", fontSize: 13 };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600 }}>{t("settings.hubBackup_title")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 14px", lineHeight: 1.5 }}>{t("settings.hubBackup_desc")}</p>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("settings.hubBackup_enable")}
      </label>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--c-tx3)" }}>
          {t("settings.hubBackup_intervalHours")}
          <input style={{ ...fieldStyle, width: 90 }} type="number" min={1} max={720} value={intervalHours} onChange={(e) => setIntervalHours(Number(e.target.value))} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--c-tx3)" }}>
          {t("settings.hubBackup_retention")}
          <input style={{ ...fieldStyle, width: 90 }} type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(Number(e.target.value))} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--c-tx3)" }}>
          {t("settings.hubBackup_destination")}
          <select style={{ ...fieldStyle, minWidth: 180 }} value={destinationId} onChange={(e) => setDestinationId(e.target.value)} aria-label={t("settings.hubBackup_destination")}>
            <option value="">{t("settings.hubBackup_localDisk")}</option>
            {(destinations ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      </div>

      {warn(t("settings.hubBackup_envWarning"))}
      {!destinationId && warn(t("settings.hubBackup_localWarning"))}

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("settings.save")}</Btn>
        <Btn variant="ghost" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "…" : t("settings.hubBackup_runNow")}</Btn>
      </div>

      {data?.last && (
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 14 }}>
          {t("settings.hubBackup_lastRun", { status: data.last.status, at: data.last.at ? new Date(data.last.at).toLocaleString() : "—" })}
        </div>
      )}
      {data && data.items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          {data.items.slice(0, 8).map((b) => (
            <div key={b.id} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, borderTop: "1px solid var(--c-bd)", paddingTop: 6 }}>
              <span style={{ fontWeight: 700, color: b.status === "SUCCESS" ? "var(--c-g)" : b.status === "FAILED" ? "var(--c-r)" : "var(--c-am)" }}>{b.status}</span>
              <span style={{ color: "var(--c-tx3)" }}>{new Date(b.createdAt).toLocaleString()}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => api.deleteHubBackupItem(b.id).then(invalidate)} aria-label={t("common.remove")} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-r)", fontSize: 11, cursor: "pointer", padding: "2px 8px", font: "inherit" }}>{t("settings.hubBackup_delete")}</button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
