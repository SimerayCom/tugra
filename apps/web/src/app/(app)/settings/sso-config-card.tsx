"use client";

import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";
import { Field, TextInput } from "../../../components/form";

/**
 * Owner-only OIDC single sign-on (SSO) configuration — a Pro-edition feature. Rendered for every settings
 * visitor but returns null unless the current user owns the instance AND the edition is Pro+ (the hub
 * enforces both; this only decides visibility and avoids a 403 fetch below Pro). The client secret is
 * write-only: the field shows a "set" placeholder and is only sent when the owner types a new value.
 */
export function SsoConfigCard() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  // Reuses the API-access card's query (same key) for the edition; only fetches the OIDC config on Pro+.
  const { data: settings } = useQuery({
    queryKey: ["instanceSettings"],
    queryFn: () => api.getInstanceSettings(),
    enabled: isOwner,
    refetchOnWindowFocus: false,
  });
  const isPro = !!settings && settings.edition !== "community";

  const { data: oidc } = useQuery({
    queryKey: ["oidcConfig"],
    queryFn: () => api.getOidcConfig(),
    enabled: isOwner && isPro,
    refetchOnWindowFocus: false,
  });

  const [enabled, setEnabled] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [domains, setDomains] = useState("");
  useEffect(() => {
    if (oidc) {
      setEnabled(oidc.oidcEnabled);
      setIssuer(oidc.oidcIssuer ?? "");
      setClientId(oidc.oidcClientId ?? "");
      setClientSecret(""); // never seeded — the secret is write-only
      setDomains(oidc.oidcAllowedDomains.join("\n"));
    }
  }, [oidc]);

  const save = useMutation({
    mutationFn: () =>
      api.updateOidcConfig({
        oidcEnabled: enabled,
        oidcIssuer: issuer.trim(),
        oidcClientId: clientId.trim(),
        // Only send the secret when the owner typed a new one — an empty field keeps the stored secret.
        ...(clientSecret ? { oidcClientSecret: clientSecret } : {}),
        oidcAllowedDomains: domains.split("\n").map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: (res) => {
      setEnabled(res.oidcEnabled);
      setIssuer(res.oidcIssuer ?? "");
      setClientId(res.oidcClientId ?? "");
      setClientSecret("");
      setDomains(res.oidcAllowedDomains.join("\n"));
      qc.invalidateQueries({ queryKey: ["oidcConfig"] });
    },
  });

  if (!isOwner || !isPro) return null;

  const domainField: React.CSSProperties = {
    width: "100%", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)",
    borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "var(--font-mono, monospace)",
    boxSizing: "border-box", resize: "vertical", minHeight: 64,
  };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("settings.sso")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("settings.ssoDesc")}</p>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ marginTop: 2, accentColor: "var(--c-a)" }} />
        <span>
          <span style={{ fontWeight: 600 }}>{t("settings.ssoEnabled")}</span>
          <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.ssoEnabledHint")}</span>
        </span>
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label={t("settings.ssoIssuer")} htmlFor="sso-issuer">
          <TextInput id="sso-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://idp.example.com" />
        </Field>
        <Field label={t("settings.ssoClientId")} htmlFor="sso-client-id">
          <TextInput id="sso-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field label={t("settings.ssoClientSecret")} htmlFor="sso-client-secret">
          <TextInput
            id="sso-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="new-password"
            placeholder={oidc?.clientSecretSet ? t("settings.ssoClientSecretSet") : ""}
          />
        </Field>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, margin: "14px 0 4px" }}>{t("settings.ssoAllowedDomains")}</div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 6 }}>{t("settings.ssoAllowedDomainsHint")}</div>
      <textarea
        aria-label={t("settings.ssoAllowedDomains")}
        style={domainField}
        placeholder={"company.com\nsub.company.com"}
        value={domains}
        onChange={(e) => setDomains(e.target.value)}
      />

      {save.isError && (
        <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>
          {save.error instanceof Error ? save.error.message : t("settings.ssoSaveFailed")}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "…" : t("settings.ssoSave")}</Btn>
      </div>
    </Card>
  );
}
