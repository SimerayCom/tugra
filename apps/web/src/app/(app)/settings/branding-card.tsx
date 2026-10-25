"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Badge, Btn, Card } from "../../../components/ui";
import { Field, TextInput } from "../../../components/form";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Owner-only white-label branding (Pro). Lets a Pro instance replace the Tugra name/logo/favicon/accent and
 * hide the "Powered by Tugra" footer, with a live preview. On Community the form is disabled behind a "Pro"
 * badge + upsell. Saving invalidates the shared ["branding"] query so the app re-themes immediately.
 */
export function BrandingCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  const { data: status } = useQuery({ queryKey: ["instanceStatus"], queryFn: () => api.getInstanceStatus(), staleTime: 60_000, enabled: isOwner });
  const isPro = !!status && status.edition !== "community";
  const { data } = useQuery({ queryKey: ["branding"], queryFn: () => api.getBranding(), enabled: isOwner, refetchOnWindowFocus: false });

  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [faviconUrl, setFaviconUrl] = useState("");
  const [accentColor, setAccentColor] = useState("");
  const [hidePoweredBy, setHidePoweredBy] = useState(false);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data && !seeded) {
      setName(data.name ?? "");
      setLogoUrl(data.logoUrl ?? "");
      setFaviconUrl(data.faviconUrl ?? "");
      setAccentColor(data.accentColor ?? "");
      setHidePoweredBy(data.hidePoweredBy);
      setSeeded(true);
    }
  }, [data, seeded]);

  const colorValid = accentColor === "" || HEX_RE.test(accentColor);

  const save = useMutation({
    mutationFn: () => api.updateBranding({ name, logoUrl, faviconUrl, accentColor, hidePoweredBy }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branding"] }); // re-theme the live app (nav/login/favicon/accent)
      toast(t("settings.brandingSaved"), "success");
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.brandingSaveFailed"), "error"),
  });

  if (!isOwner) return null;

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600 }}>{t("settings.branding")}</div>
        {!isPro && <Badge tone="gold">Pro</Badge>}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 14px", lineHeight: 1.5 }}>{t("settings.brandingDesc")}</p>

      {!isPro && (
        <div style={{ fontSize: 12, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "9px 11px", marginBottom: 14 }}>
          {t("settings.brandingProHint")}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, opacity: isPro ? 1 : 0.55, pointerEvents: isPro ? "auto" : "none" }}>
        <Field label={t("settings.brandingName")} htmlFor="brand-name">
          <TextInput id="brand-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tugra" maxLength={40} disabled={!isPro} />
        </Field>
        <Field label={t("settings.brandingLogo")} htmlFor="brand-logo">
          <TextInput id="brand-logo" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.svg" disabled={!isPro} />
        </Field>
        <Field label={t("settings.brandingFavicon")} htmlFor="brand-favicon">
          <TextInput id="brand-favicon" value={faviconUrl} onChange={(e) => setFaviconUrl(e.target.value)} placeholder="https://…/favicon.png" disabled={!isPro} />
        </Field>
        <Field label={t("settings.brandingAccent")} htmlFor="brand-accent" error={colorValid ? undefined : t("settings.brandingAccentInvalid")}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, border: "1px solid var(--c-bd)", background: colorValid && accentColor ? accentColor : "var(--c-a)", flexShrink: 0 }} />
            <TextInput id="brand-accent" value={accentColor} onChange={(e) => setAccentColor(e.target.value.trim())} placeholder="#d4af6a" disabled={!isPro} />
          </div>
        </Field>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: isPro ? "pointer" : "not-allowed", fontSize: 13 }}>
          <input type="checkbox" checked={hidePoweredBy} onChange={(e) => setHidePoweredBy(e.target.checked)} disabled={!isPro} style={{ marginTop: 2, accentColor: "var(--c-a)" }} />
          <span>
            <span style={{ fontWeight: 600 }}>{t("settings.brandingHidePowered")}</span>
            <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.brandingHidePoweredHint")}</span>
          </span>
        </label>
      </div>

      {/* Live preview of the mark the way the nav/login renders it. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, padding: "10px 12px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl || "/tugra-logo.svg"} alt="" width={28} height={28} style={{ objectFit: "contain" }} onError={(e) => { (e.target as HTMLImageElement).src = "/tugra-logo.svg"; }} />
        <span style={{ fontWeight: 700, fontSize: 16 }}>{name || "Tugra"}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.brandingPreview")}</span>
      </div>

      {isPro && (
        <div style={{ marginTop: 16 }}>
          <Btn onClick={() => save.mutate()} disabled={save.isPending || !colorValid}>{save.isPending ? "…" : t("settings.brandingSave")}</Btn>
        </div>
      )}
    </Card>
  );
}
