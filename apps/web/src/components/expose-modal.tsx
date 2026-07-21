"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { cleanDomain } from "../lib/domain";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { Field, TextInput } from "./form";
import { Modal } from "./modal";
import { useToast } from "./toast";

type Mode = "magic" | "port" | "custom" | "none";
const MODES: Mode[] = ["magic", "port", "custom", "none"];

/** Choose how an app is reached: an auto magic domain, a raw host:port, a custom
 *  domain, or nothing. Applied to the proxy on the next deploy. */
export function ExposeModal({
  appId,
  current,
  currentDomain,
  onClose,
}: {
  appId: string;
  current?: string | null;
  currentDomain?: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>((current as Mode) || "magic");
  const [domain, setDomain] = useState(currentDomain ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.exposeApp(appId, { mode, domain: mode === "custom" ? cleanDomain(domain) : undefined }),
    onSuccess: async (app) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["apps"] }),
        qc.invalidateQueries({ queryKey: ["app", appId] }),
      ]);
      // Magic/port can't always produce a reachable URL (COMPOSE app, or a server
      // with no public IP / wildcard) — be honest instead of a blanket "updated".
      if ((mode === "magic" || mode === "port") && !app.url) {
        toast(t("apps.exposeNoUrl"), "info");
      } else {
        toast(t("apps.exposeSaved"), "success");
      }
      onClose();
    },
  });

  const invalid = mode === "custom" && !cleanDomain(domain);

  // Per-app "publicly accessible via tunnel" — only meaningful when the app's server has a
  // live Cloudflare Tunnel. Self-fetch the app (for serverId + current toggle) and tunnel status.
  const appQ = useQuery({ queryKey: ["app", appId], queryFn: () => api.getApp(appId) });
  const serverId = appQ.data?.serverId;
  const tunnelQ = useQuery({
    queryKey: ["tunnel", serverId],
    queryFn: () => api.getTunnelStatus(serverId as string),
    enabled: !!serverId,
  });
  const tunnelReady = !!tunnelQ.data?.configured && tunnelQ.data.status === "connected";
  const setTunnel = useMutation({
    mutationFn: (exposed: boolean) => api.setAppTunnel(appId, exposed),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app", appId] });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
  });

  return (
    <Modal onClose={onClose}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>{t("apps.exposeTitle")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {MODES.map((m) => (
          <label
            key={m}
            style={{
              display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", cursor: "pointer",
              borderRadius: "var(--r1)", border: "1px solid var(--c-bd)",
              background: mode === m ? "var(--c-el)" : "transparent",
            }}
          >
            <input type="radio" name="expose-mode" checked={mode === m} onChange={() => setMode(m)} style={{ marginTop: 2 }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 14, color: "var(--c-tx)" }}>{t(`apps.exposeMode_${m}`)}</span>
              <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t(`apps.exposeModeDesc_${m}`)}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === "custom" && (
        <div style={{ marginTop: 12 }}>
          <Field label={t("apps.setDomain")} htmlFor="expose-domain">
            <TextInput
              id="expose-domain"
              value={domain}
              placeholder={t("apps.domainPlaceholder")}
              onChange={(e) => setDomain(e.target.value)}
            />
          </Field>
        </div>
      )}
      {tunnelReady && appQ.data && (
        <label
          style={{
            display: "flex", gap: 10, alignItems: "flex-start", marginTop: 12, padding: "10px 12px",
            cursor: appQ.data.domain ? "pointer" : "default", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)",
          }}
        >
          <input
            type="checkbox"
            checked={appQ.data.tunnelExposed}
            disabled={setTunnel.isPending || !appQ.data.domain}
            onChange={(e) => setTunnel.mutate(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 14, color: "var(--c-tx)" }}>{t("apps.tunnelExpose")}</span>
            <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>
              {appQ.data.domain ? t("apps.tunnelExposeDesc") : t("apps.tunnelExposeNeedsDomain")}
            </span>
          </span>
        </label>
      )}
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "12px 0 0" }}>{t("apps.exposeApplyNote")}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn onClick={() => save.mutate()} disabled={save.isPending || invalid}>{t("apps.exposeSave")}</Btn>
      </div>
    </Modal>
  );
}
