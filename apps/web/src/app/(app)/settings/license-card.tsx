"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";
import { Field } from "../../../components/form";

/**
 * Owner-only license/plan card. Shows the effective plan + license validity/expiry and lets the owner paste
 * a signed license token to unlock Pro/Cloud (or clear it to downgrade). Not edition-gated — a Community
 * instance must be able to see this and upgrade. The token is write-only (never returned by the API).
 */
export function LicenseCard() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  const { data } = useQuery({
    queryKey: ["license"],
    queryFn: () => api.getLicense(),
    enabled: isOwner,
    refetchOnWindowFocus: false,
  });

  const [token, setToken] = useState("");
  const activate = useMutation({
    mutationFn: (tok: string) => api.activateLicense(tok),
    onSuccess: () => {
      setToken("");
      // The edition may have changed → refresh anything that gates on it (license status + settings).
      qc.invalidateQueries({ queryKey: ["license"] });
      qc.invalidateQueries({ queryKey: ["instanceSettings"] });
    },
  });

  if (!isOwner) return null;

  const plan = data?.plan ?? "community";
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const expiry = data?.expiresAt ? new Date(data.expiresAt).toLocaleDateString() : null;

  const field: React.CSSProperties = {
    width: "100%", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)",
    borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "var(--font-mono, monospace)",
    boxSizing: "border-box", resize: "vertical", minHeight: 64,
  };

  return (
    <Card style={{ padding: 18, marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("settings.license")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("settings.licenseDesc")}</p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("settings.licensePlan")}</span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{planLabel}</span>
        {data?.valid && expiry && (
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>· {t("settings.licenseActiveUntil", { date: expiry })}</span>
        )}
        {data && !data.valid && data.source && (
          <span style={{ fontSize: 12, color: "var(--c-r)" }}>· {t("settings.licenseInvalidStored")}</span>
        )}
      </div>

      <Field label={t("settings.licenseToken")} htmlFor="license-token" hint={t("settings.licenseTokenHint")}>
        <textarea
          id="license-token"
          style={field}
          placeholder="eyJhbGciOiJFZERTQSJ9…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>

      {activate.isError && (
        <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>
          {activate.error instanceof Error ? activate.error.message : t("settings.licenseActivateFailed")}
        </div>
      )}

      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn onClick={() => activate.mutate(token.trim())} disabled={activate.isPending || !token.trim()}>
          {activate.isPending ? "…" : t("settings.licenseActivate")}
        </Btn>
        {/* Show Remove whenever a token is STORED (valid or not) so an expired/invalid license can be
            cleared — matching the hint text. `source` is set even when the stored token no longer verifies. */}
        {(data?.valid || data?.source) && (
          <Btn variant="ghost" onClick={() => activate.mutate("")} disabled={activate.isPending}>
            {t("settings.licenseRemove")}
          </Btn>
        )}
      </div>
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("settings.licenseProUnavailable")}</p>
    </Card>
  );
}
