"use client";

import { useState } from "react";
import Link from "next/link";
import { Unlink } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { useIsPro } from "../hooks/useIsPro";
import { Badge, Btn, Card, EmptyState } from "./ui";
import { Select, fieldStyle } from "./form";

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Light client check for a Vault KV v2 locator "<mount>/<path>#<field>" — the hub is authoritative.
const locatorOk = (s: string) => s.includes("/") && /#[^#]+$/.test(s);

/**
 * Bind an external secret-store value into an app's env on every deploy (Pro). Only the locator is stored
 * here, never the value. Refs resolve on classic, compose AND swarm deploys, so this card is shown for all
 * non-preview apps (config-groups), unlike database-links which is classic-only.
 */
export function AppSecretRefsCard({ id, teamId, canWrite }: { id: string; teamId: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { ready, isPro } = useIsPro();
  const refs = useQuery({ queryKey: ["appSecretRefs", id], queryFn: () => api.getAppSecretRefs(id) });
  const providers = useQuery({ queryKey: ["secretProviders"], queryFn: () => api.listSecretProviders(), enabled: canWrite });

  const [providerId, setProviderId] = useState("");
  const [envVar, setEnvVar] = useState("");
  const [remoteKey, setRemoteKey] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["appSecretRefs", id] });
    qc.invalidateQueries({ queryKey: ["secretProviders"] }); // refCount changed
    qc.invalidateQueries({ queryKey: ["app", id] });
  };
  const bind = useMutation({
    mutationFn: () => api.bindAppSecret(id, { providerId, envVar: envVar.trim(), remoteKey: remoteKey.trim() }),
    onSuccess: () => { setProviderId(""); setEnvVar(""); setRemoteKey(""); invalidate(); },
    meta: { successMessage: t("apps.secretRefsBound") },
  });
  const unbind = useMutation({
    mutationFn: (refId: string) => api.unbindAppSecret(id, refId),
    onSuccess: invalidate,
    meta: { successMessage: t("apps.secretRefsUnbound") },
  });

  const list = refs.data ?? [];
  // The hub requires a same-team provider the caller can write; never offer cross-team/unusable names.
  const eligible = (providers.data ?? []).filter((p) => p.teamId === teamId && p.canWrite);
  const envInvalid = envVar.trim().length > 0 && (!ENV_RE.test(envVar.trim()) || envVar.trim().length > 128);
  const locInvalid = remoteKey.trim().length > 0 && !locatorOk(remoteKey.trim());
  const gate = !ready || !isPro;

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
        {t("apps.secretRefsTitle")}
        {ready && !isPro && <Badge tone="gold">{t("common.pro")}</Badge>}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.secretRefsDesc")}</p>

      {ready && !isPro && <div style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.secretRefsProHint")}</div>}

      {list.length === 0 ? (
        <EmptyState>{t("apps.secretRefsEmpty")}</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((r) => (
            <div key={r.refId} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 10px" }}>
              <code style={{ fontSize: 11, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "1px 6px" }}>{r.envVar}</code>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{r.providerName}</span>
              <Badge>{r.kind}</Badge>
              <code style={{ fontSize: 11, color: "var(--c-tx3)", overflowWrap: "anywhere" }}>{r.remoteKey}</code>
              {r.overridesAppEnv && <span style={{ fontSize: 11, color: "var(--c-am)" }}>{t("apps.secretRefsOverrides")}</span>}
              <span style={{ flex: 1 }} />
              {canWrite && (
                <button onClick={() => unbind.mutate(r.refId)} disabled={unbind.isPending} style={{ background: "transparent", border: "none", color: "var(--c-r)", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center" }} aria-label={t("apps.secretRefsUnbind")}>
                  <Unlink size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canWrite && (
        eligible.length === 0 && ready && isPro ? (
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "12px 0 0", lineHeight: 1.5 }}>
            {t("apps.secretRefsNoProviders")} <Link href="/secret-providers" style={{ color: "var(--c-a)" }}>{t("apps.secretRefsManageProviders")}</Link>
          </p>
        ) : (
          <fieldset disabled={gate} style={{ border: "none", padding: 0, margin: "12px 0 0", opacity: isPro ? 1 : 0.55 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Select
                value={providerId}
                onChange={setProviderId}
                placeholder={t("apps.secretRefsPickProvider")}
                options={eligible.map((p) => ({ value: p.id, label: `${p.name} · ${p.kind}` }))}
                disabled={gate}
                style={{ minWidth: 200 }}
              />
              <input
                style={{ ...fieldStyle, width: "100%", boxSizing: "border-box" }}
                placeholder={t("apps.secretRefsEnvVarPlaceholder")}
                value={envVar}
                onChange={(e) => setEnvVar(e.target.value)}
                aria-label={t("apps.secretRefsEnvVar")}
                autoComplete="off"
                spellCheck={false}
                disabled={gate}
              />
              {envInvalid && <span style={{ fontSize: 11, color: "var(--c-r)" }}>{t("apps.secretRefsEnvVarInvalid")}</span>}
              <input
                style={{ ...fieldStyle, width: "100%", boxSizing: "border-box", fontFamily: "var(--font-mono, monospace)" }}
                placeholder={t("apps.secretRefsLocatorPlaceholder")}
                value={remoteKey}
                onChange={(e) => setRemoteKey(e.target.value)}
                aria-label={t("apps.secretRefsLocator")}
                autoComplete="off"
                spellCheck={false}
                disabled={gate}
              />
              <span style={{ fontSize: 11, color: locInvalid ? "var(--c-r)" : "var(--c-tx3)" }}>{locInvalid ? t("apps.secretRefsLocatorInvalid") : t("apps.secretRefsLocatorHint")}</span>
              <div style={{ display: "flex" }}>
                <div style={{ flex: 1 }} />
                <Btn
                  onClick={() => bind.mutate()}
                  disabled={gate || bind.isPending || !providerId || !envVar.trim() || !remoteKey.trim() || envInvalid || locInvalid}
                >
                  {t("apps.secretRefsBind")}
                </Btn>
              </div>
              {bind.isError && <div style={{ color: "var(--c-r)", fontSize: 12 }}>{(bind.error as Error).message}</div>}
            </div>
          </fieldset>
        )
      )}
      {list.length > 0 && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 10, lineHeight: 1.5 }}>{t("apps.secretRefsRedeploy")}</div>}
    </Card>
  );
}
