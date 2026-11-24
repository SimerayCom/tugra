"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, TriangleAlert } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { relativeTime } from "../../../lib/fleet";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Badge, Btn, Card, EmptyState } from "../../../components/ui";
import { tokenExpiry } from "../../../lib/api-token-expiry";
import type { ApiToken } from "../../../lib/types";
import { useConfirm } from "../../../components/confirm";
import { ApiTokenForm, SCOPE_OPTIONS, field } from "./api-token-form";
import { ApiTokenReveal } from "./api-token-reveal";
import { ApiTokenUsage } from "./api-token-usage";

type FormMode = "custom" | "mcp" | null;

/** Shown to the instance owner when token access is switched off: every token would be rejected. */
function ApiOffNotice() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const { data } = useQuery({
    queryKey: ["instanceSettings"],
    queryFn: () => api.getInstanceSettings(),
    enabled: isOwner,
    refetchOnWindowFocus: false,
  });
  const turnOn = useMutation({
    mutationFn: () => api.updateInstanceSettings({ apiEnabled: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instanceSettings"] }),
  });
  if (!isOwner || !data || data.apiEnabled) return null;
  return (
    <div role="status" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12, padding: "10px 12px", border: "1px solid var(--c-am)", borderRadius: "var(--r1)", background: "color-mix(in srgb, var(--c-am) 10%, transparent)", fontSize: 13 }}>
      <TriangleAlert size={16} aria-hidden style={{ color: "var(--c-am)", flexShrink: 0 }} />
      <span style={{ flex: "1 1 220px" }}>{t("settings.apiOffNotice")}</span>
      <Btn onClick={() => turnOn.mutate()} loading={turnOn.isPending} style={{ minHeight: 44 }}>{t("settings.apiOffTurnOn")}</Btn>
      {turnOn.isError && <span role="alert" style={{ flexBasis: "100%", fontSize: 12, color: "var(--c-r)" }}>{t("settings.apiOffFailed")}</span>}
    </div>
  );
}

export function ApiTokensCard() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const { data: tokens = [] } = useQuery({ queryKey: ["apiTokens"], queryFn: () => api.listApiTokens() });
  const [mode, setMode] = useState<FormMode>(null);
  const [fresh, setFresh] = useState<{ token: string; mcp: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [usageOpen, setUsageOpen] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteApiToken(id),
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: ["apiTokens"] });
      toast(t("common.revokedNamed", { name: tokens.find((tk) => tk.id === id)?.name ?? "" }), "success");
    },
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.renameApiToken(v.id, v.name),
    onSuccess: () => {
      setRenaming(null);
      qc.invalidateQueries({ queryKey: ["apiTokens"] });
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api.rotateApiToken(id),
    onSuccess: (res) => {
      setMode(null);
      setFresh({ token: res.token, mcp: false });
      qc.invalidateQueries({ queryKey: ["apiTokens"] });
      qc.invalidateQueries({ queryKey: ["apiTokenUsage", res.view.id] });
    },
  });

  const scopeLabel = (sc: string) => {
    const o = SCOPE_OPTIONS.find((s) => s.key === sc);
    return o ? t(`settings.scope${o.stem}`) : sc;
  };

  const linkBtn: React.CSSProperties = { background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" };

  const expiryNode = (tk: ApiToken) => {
    const ex = tokenExpiry(tk.expiresAt);
    if (ex.state === "none") return <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("settings.tokenNoExpiry")}</span>;
    if (ex.state === "expired") return <Badge tone="danger">{t("settings.tokenExpired")}</Badge>;
    if (ex.state === "soon") return <Badge tone="warn">{ex.days === 1 ? t("settings.tokenDayLeft") : t("settings.tokenDaysLeft", { n: ex.days })}</Badge>;
    return <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("settings.tokenExpires", { date: new Date(tk.expiresAt!).toLocaleDateString() })}</span>;
  };

  const open = (m: Exclude<FormMode, null>) => {
    setFresh(null);
    setMode((cur) => (cur === m ? null : m));
  };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("settings.apiTokens")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("settings.apiTokensDesc")}</p>

      <ApiOffNotice />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn onClick={() => open("custom")} aria-expanded={mode === "custom"} style={{ minHeight: 44 }}>{t("settings.tokenCreateOpen")}</Btn>
        <Btn variant="ghost" onClick={() => open("mcp")} aria-expanded={mode === "mcp"} style={{ minHeight: 44 }}>{t("settings.tokenMcp")}</Btn>
      </div>

      {mode && (
        <ApiTokenForm
          key={mode}
          mcp={mode === "mcp"}
          isOwner={isOwner}
          onCancel={() => setMode(null)}
          onCreated={(token) => {
            setFresh({ token, mcp: mode === "mcp" });
            setMode(null);
            qc.invalidateQueries({ queryKey: ["apiTokens"] });
          }}
        />
      )}

      {fresh && <ApiTokenReveal token={fresh.token} mcp={fresh.mcp} onDone={() => setFresh(null)} />}

      {tokens.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <table className="tok-table" aria-label={t("settings.tokenListLabel")}>
            <thead>
              <tr>
                <th scope="col">{t("settings.tokenColName")}</th>
                <th scope="col">{t("settings.tokenColAccess")}</th>
                <th scope="col">{t("settings.tokenColLastUsed")}</th>
                <th scope="col">{t("settings.tokenColExpires")}</th>
                <th scope="col">{t("settings.tokenColCreatedBy")}</th>
                <th scope="col">{t("settings.tokenColActions")}</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((tk) => {
                const expired = tokenExpiry(tk.expiresAt).state === "expired";
                const editing = renaming?.id === tk.id;
                const showUsage = usageOpen === tk.id;
                return (
                  <React.Fragment key={tk.id}>
                    <tr>
                      <td data-label={t("settings.tokenColName")}>
                        {editing ? (
                          <form
                            onSubmit={(e) => { e.preventDefault(); if (renaming.name.trim()) rename.mutate({ id: tk.id, name: renaming.name.trim() }); }}
                            style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
                          >
                            <input
                              autoFocus
                              style={{ ...field, padding: "4px 8px", minHeight: 36 }}
                              aria-label={t("settings.tokenRenameLabel")}
                              value={renaming.name}
                              maxLength={100}
                              onChange={(e) => setRenaming({ id: tk.id, name: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }}
                            />
                            <button type="submit" className="tok-act" disabled={rename.isPending || !renaming.name.trim()} style={linkBtn}>{t("common.save")}</button>
                            <button type="button" className="tok-act" onClick={() => setRenaming(null)} style={{ ...linkBtn, color: "var(--c-tx3)" }}>{t("common.cancel")}</button>
                          </form>
                        ) : (
                          <span>
                            <span style={{ fontWeight: 600 }}>{tk.name}</span>
                            <span className="mono" style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{tk.prefix}…</span>
                          </span>
                        )}
                      </td>
                      <td data-label={t("settings.tokenColAccess")}>
                        <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {tk.scopes.map((sc) => (
                            <span key={sc} title={sc} style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999, background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx2)" }}>{scopeLabel(sc)}</span>
                          ))}
                        </span>
                      </td>
                      <td data-label={t("settings.tokenColLastUsed")} style={{ fontSize: 12, color: "var(--c-tx3)" }}>
                        {tk.lastUsedAt ? <span title={new Date(tk.lastUsedAt).toLocaleString()}>{relativeTime(tk.lastUsedAt, t)}</span> : t("settings.tokenNever")}
                      </td>
                      <td data-label={t("settings.tokenColExpires")}>{expiryNode(tk)}</td>
                      <td data-label={t("settings.tokenColCreatedBy")} style={{ fontSize: 12, color: "var(--c-tx3)", wordBreak: "break-word" }}>
                        {tk.createdBy ? (tk.createdBy.name || tk.createdBy.email) : t("settings.tokenUnknown")}
                      </td>
                      <td data-label={t("settings.tokenColActions")}>
                        <span style={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center" }}>
                          <button type="button" className="tok-act" aria-expanded={showUsage} onClick={() => setUsageOpen(showUsage ? null : tk.id)} aria-label={t("settings.tokenUsageNamed", { name: tk.name })} style={linkBtn}>
                            {t("settings.tokenUsage")}
                          </button>
                          {!editing && (
                            <button type="button" className="tok-act" onClick={() => setRenaming({ id: tk.id, name: tk.name })} aria-label={t("settings.tokenRenameNamed", { name: tk.name })} style={linkBtn}>
                              {t("settings.tokenRename")}
                            </button>
                          )}
                          {!expired && (
                            <button
                              type="button"
                              className="tok-act"
                              disabled={rotate.isPending}
                              onClick={async () => { if (await confirm({ title: t("settings.tokenRotateTitle"), body: t("settings.tokenRotateBody", { name: tk.name }), danger: true })) rotate.mutate(tk.id); }}
                              aria-label={t("settings.tokenRotateNamed", { name: tk.name })}
                              style={linkBtn}
                            >
                              {t("settings.tokenRotate")}
                            </button>
                          )}
                          <button type="button" className="tok-act" onClick={async () => { if (await confirm({ body: t("common.deleteNamedConfirm", { name: tk.name }), danger: true })) revoke.mutate(tk.id); }} style={{ ...linkBtn, color: "var(--c-r)" }}>
                            {t("settings.revoke")}
                          </button>
                        </span>
                      </td>
                    </tr>
                    {showUsage && (
                      <tr className="tok-usage-row">
                        <td colSpan={6}><ApiTokenUsage tokenId={tk.id} /></td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tokens.length === 0 && (
        <div style={{ marginTop: 12 }}>
          <EmptyState icon={KeyRound} title={t("settings.noTokensTitle")}>{t("settings.noTokens")}</EmptyState>
        </div>
      )}
    </Card>
  );
}
