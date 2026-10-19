"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Card, Btn } from "./ui";
import { Field, TextInput } from "./form";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";

/**
 * Home-mode "Remote access" card: a plain-language, few-click wrapper over the existing server-level
 * Cloudflare Tunnel (TunnelService). It gives a single-box owner HTTPS access to their apps from anywhere
 * with NO port-forwarding and NO open inbound ports — the thing a CasaOS-style single box can't do. It
 * drives the same `POST/GET/DELETE /servers/:id/tunnel` API the fleet servers page uses; only the surface
 * is simplified. Honest scope: it still needs a Cloudflare account + a domain on Cloudflare.
 */
export function RemoteAccessCard({ serverId }: { serverId: string }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: tun, isPending, isError } = useQuery({ queryKey: ["tunnel", serverId], queryFn: () => api.getTunnelStatus(serverId) });

  const [apiToken, setApiToken] = useState("");
  const [cfAccountId, setCfAccountId] = useState("");
  const [zoneName, setZoneName] = useState("");

  const setup = useMutation({
    mutationFn: () => api.setupTunnel(serverId, { apiToken: apiToken.trim(), cfAccountId: cfAccountId.trim(), zoneName: zoneName.trim() }),
    onSuccess: () => {
      setApiToken("");
      qc.invalidateQueries({ queryKey: ["tunnel", serverId] });
      qc.invalidateQueries({ queryKey: ["apps"] }); // app tunnelExposed/url may change → refresh launcher badges
      toast(t("home.remoteAccessEnabled"), "success");
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("home.remoteAccessFailed"), "error"),
  });

  const teardown = useMutation({
    mutationFn: () => api.teardownTunnel(serverId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tunnel", serverId] });
      qc.invalidateQueries({ queryKey: ["apps"] }); // apps lose tunnel exposure → clear stale "Available anywhere" badges
      toast(t("home.remoteAccessOff"), "success");
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("home.remoteAccessFailed"), "error"),
  });

  // Stay quiet until the status loads, and on error — never show the setup form for a server whose tunnel
  // status failed to load (it may already be configured; offering "Enable" would be misleading).
  if (isPending || isError) return null;

  const configured = tun?.configured;
  const turnOff = async () => {
    if (await confirm({ title: t("home.remoteAccessTurnOff"), body: t("home.remoteAccessTurnOffConfirm"), danger: true })) {
      teardown.mutate();
    }
  };

  return (
    <Card style={{ padding: 16, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Globe size={18} color="var(--c-a)" />
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{t("home.remoteAccessTitle")}</h2>
        {configured && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--c-g)", background: "color-mix(in srgb, var(--c-g) 15%, transparent)", padding: "1px 8px", borderRadius: 999 }}>{t("home.remoteAccessActive")}</span>}
      </div>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 14px", lineHeight: 1.4 }}>{t("home.remoteAccessBody")}</p>

      {configured ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--c-tx2)" }}>{tun?.zoneName ?? "—"}</span>
          <Btn variant="ghost" onClick={turnOff} disabled={teardown.isPending}>{t("home.remoteAccessTurnOff")}</Btn>
        </div>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); setup.mutate(); }}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <Field label={t("home.remoteAccessToken")} htmlFor="ra-token" hint={t("home.remoteAccessTokenHint")}>
            <TextInput id="ra-token" type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} required />
          </Field>
          <Field label={t("home.remoteAccessAccount")} htmlFor="ra-acct">
            <TextInput id="ra-acct" value={cfAccountId} onChange={(e) => setCfAccountId(e.target.value)} required />
          </Field>
          <Field label={t("home.remoteAccessZone")} htmlFor="ra-zone">
            <TextInput id="ra-zone" value={zoneName} placeholder="example.com" onChange={(e) => setZoneName(e.target.value)} required />
          </Field>
          <Btn type="submit" disabled={setup.isPending || !apiToken.trim() || !cfAccountId.trim() || !zoneName.trim()} style={{ alignSelf: "flex-start" }}>
            {setup.isPending ? "…" : t("home.remoteAccessEnable")}
          </Btn>
        </form>
      )}
    </Card>
  );
}
