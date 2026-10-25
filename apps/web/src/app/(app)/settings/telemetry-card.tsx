"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card } from "../../../components/ui";
import { useToast } from "../../../components/toast";

/**
 * Owner-only anonymous usage stats panel. On by default, opt-out. Shows the effective state, a live preview
 * of the EXACT payload that would be sent (so the owner can verify there's no IP/host/domain/PII), and lets
 * them flip the toggle, send now, or rotate the anonymous id. Returns null for non-owners (the hub enforces
 * the same guard). When TUGRA_TELEMETRY=0 is set in the environment, the toggle is shown inert with a note.
 */
export function TelemetryCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const [showPayload, setShowPayload] = useState(false);

  const { data } = useQuery({
    queryKey: ["instanceTelemetry"],
    queryFn: () => api.getTelemetry(),
    enabled: isOwner,
    refetchOnWindowFocus: false,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateTelemetry(enabled),
    onSuccess: (res) => {
      qc.setQueryData(["instanceTelemetry"], res);
      toast(res.dbEnabled ? t("settings.telemetryThanks") : t("settings.telemetryOffToast"), "success");
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.telemetrySaveFailed"), "error"),
  });

  const send = useMutation({
    mutationFn: () => api.sendTelemetryNow(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["instanceTelemetry"] });
      const key = res.status === "sent" ? "settings.telemetrySent" : res.status === "disabled" ? "settings.telemetrySendDisabled" : "settings.telemetrySendError";
      toast(t(key), res.status === "sent" ? "success" : "error");
    },
  });

  const reset = useMutation({
    mutationFn: () => api.resetTelemetryId(),
    onSuccess: (res) => { qc.setQueryData(["instanceTelemetry"], res); toast(t("settings.telemetryResetDone"), "success"); },
  });

  if (!isOwner) return null;

  const hours = data ? Math.round(data.intervalMin / 60) : 24;
  const lastSent = data?.lastSentAt ? new Date(data.lastSentAt).toLocaleString() : t("settings.telemetryNever");

  return (
    <Card style={{ padding: 18, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600 }}>{t("settings.telemetry")}</div>
        {data && (
          data.enabled
            ? <Badge tone="gold">{t("settings.telemetryOn")}</Badge>
            : <Badge tone="muted">{t("settings.telemetryOff")}</Badge>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 14px", lineHeight: 1.5 }}>{t("settings.telemetryDesc")}</p>

      {data?.forcedOff && (
        <div style={{ fontSize: 12, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "9px 11px", marginBottom: 14 }}>
          {t("settings.telemetryForcedOff")}
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: data?.forcedOff ? "not-allowed" : "pointer", fontSize: 13, margin: "0 0 14px", opacity: data?.forcedOff ? 0.55 : 1 }}>
        <input
          type="checkbox"
          checked={!!data?.dbEnabled}
          disabled={data?.forcedOff || toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
          style={{ marginTop: 2, accentColor: "var(--c-a)" }}
        />
        <span>
          <span style={{ fontWeight: 600 }}>{t("settings.telemetryEnabledLabel")}</span>
          <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.telemetryEnabledHint")}</span>
        </span>
      </label>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 12, color: "var(--c-tx3)", marginBottom: 14 }}>
        <span>{t("settings.telemetryLastSent")}: <span style={{ color: "var(--c-tx2)" }}>{lastSent}</span></span>
        <span>{t("settings.telemetryEvery", { hours })}</span>
        {data?.instanceId && (
          <span>{t("settings.telemetryInstanceId")}: <code style={{ fontSize: 11 }}>{data.instanceId.slice(0, 8)}…</code></span>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowPayload((v) => !v)}
        aria-expanded={showPayload}
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--c-a)", fontSize: 12, fontFamily: "inherit" }}
      >
        {showPayload ? t("settings.telemetryPreviewHide") : t("settings.telemetryPreview")}
      </button>
      {showPayload && data && (
        <pre
          className="mono"
          style={{ marginTop: 10, padding: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", fontSize: 11, lineHeight: 1.5, overflowX: "auto", color: "var(--c-tx2)" }}
        >
          {JSON.stringify(data.payload, null, 2)}
        </pre>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
        <Btn onClick={() => send.mutate()} disabled={send.isPending || !data?.enabled}>
          {send.isPending ? "…" : t("settings.telemetrySendNow")}
        </Btn>
        <Btn variant="ghost" onClick={() => reset.mutate()} disabled={reset.isPending}>
          {t("settings.telemetryReset")}
        </Btn>
      </div>
    </Card>
  );
}
