"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Btn, Card } from "../../../components/ui";

/**
 * Owner-only control-panel HTTPS (DİLİM 1). The panel domain is bound to the install-time origin
 * (HUB_PUBLIC_URL), so this card is read-only STATUS + an idempotent Re-apply — not a domain form. Changing
 * the domain is an installer re-run. Re-apply re-provisions the proxy (useful after switching to DNS-01).
 */
export function PanelTlsCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  const { data } = useQuery({
    queryKey: ["panelTls"],
    queryFn: () => api.getPanelTls(),
    enabled: isOwner,
    refetchOnWindowFocus: false,
  });

  const reapply = useMutation({
    mutationFn: () => api.applyPanelTls(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["panelTls"] });
      toast(t("settings.panelTlsReapplied"), "success");
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.panelTlsReapplyFailed"), "error"),
  });

  if (!isOwner) return null;

  const ok = "var(--c-g)";
  const bad = "var(--c-r)";
  const row = (label: string, value: string, tone?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, padding: "4px 0" }}>
      <span style={{ color: "var(--c-tx3)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: tone ?? "var(--c-tx)" }}>{value}</span>
    </div>
  );
  const warn = (msg: string) => (
    <div style={{ fontSize: 12, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "9px 11px", marginTop: 12 }}>
      {msg}
    </div>
  );

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600 }}>{t("settings.panelTls")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 14px", lineHeight: 1.5 }}>{t("settings.panelTlsDesc")}</p>

      {data && !data.enabled && (
        <div style={{ fontSize: 13, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "9px 11px" }}>
          {t("settings.panelTlsOff")}
        </div>
      )}

      {data && data.enabled && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {row(t("settings.panelTlsDomain"), data.domain ?? "—")}
            {row(t("settings.panelTlsResolver"), (data.resolver ?? "le").toUpperCase())}
            {row(t("settings.panelTlsServer"), data.localServerOnline ? t("settings.panelTlsOnline") : t("settings.panelTlsOffline"), data.localServerOnline ? ok : bad)}
            {row(t("settings.panelTlsProxy"), data.proxyRunning ? t("settings.panelTlsRunning") : t("settings.panelTlsStopped"), data.proxyRunning ? ok : bad)}
            {row(t("settings.panelTlsRouter"), data.routerPresent ? t("settings.panelTlsPresent") : t("settings.panelTlsAbsent"), data.routerPresent ? ok : bad)}
          </div>
          {!data.originMatches && warn(t("settings.panelTlsOriginMismatch"))}
          {!data.acmeEmailOk && warn(t("settings.panelTlsEmailBad"))}
          <div style={{ marginTop: 16 }}>
            <Btn onClick={() => reapply.mutate()} disabled={reapply.isPending || !data.localServerOnline}>
              {reapply.isPending ? "…" : t("settings.panelTlsReapply")}
            </Btn>
          </div>
        </>
      )}
    </Card>
  );
}
