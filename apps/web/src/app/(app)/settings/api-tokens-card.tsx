"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { api } from "../../../lib/api";
import type { ApiTokenScope } from "../../../lib/types";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState } from "../../../components/ui";
import { tokenExpiry } from "../../../lib/api-token-expiry";
import type { ApiToken } from "../../../lib/types";
import { CopyBtn } from "../../../components/copy-row";
import { useConfirm } from "../../../components/confirm";

/** Grantable scopes in display order, with the i18n key stem and whether it's owner-only. `read` is the
 *  baseline every token carries (checkbox is checked + locked). */
const SCOPE_OPTIONS: { key: ApiTokenScope; stem: string; ownerOnly: boolean }[] = [
  { key: "read", stem: "Read", ownerOnly: false },
  { key: "write", stem: "Write", ownerOnly: false },
  { key: "deploy", stem: "Deploy", ownerOnly: false },
  { key: "read:secrets", stem: "ReadSecrets", ownerOnly: true },
  { key: "admin", stem: "Admin", ownerOnly: true },
];

export function ApiTokensCard() {
  const t = useT();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const { data: tokens = [] } = useQuery({ queryKey: ["apiTokens"], queryFn: () => api.listApiTokens() });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiTokenScope[]>(["read"]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const visibleScopes = SCOPE_OPTIONS.filter((s) => isOwner || !s.ownerOnly);
  const toggleScope = (key: ApiTokenScope) => {
    if (key === "read") return; // baseline, always on
    setScopes((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };

  const create = useMutation({
    // Keep display order and drop any scope the current user can't grant (owner-only guard, defence in depth).
    mutationFn: () => {
      const granted = visibleScopes.filter((s) => scopes.includes(s.key)).map((s) => s.key);
      const days = Number(expiryDays);
      return expiryDays.trim() && Number.isInteger(days) && days >= 1 ? api.createApiToken(name, granted, days) : api.createApiToken(name, granted);
    },
    onSuccess: (res) => {
      setFresh(res.token);
      setName("");
      setExpiryDays("");
      setScopes(["read"]);
      qc.invalidateQueries({ queryKey: ["apiTokens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteApiToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apiTokens"] }),
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
      setFresh(res.token);
      qc.invalidateQueries({ queryKey: ["apiTokens"] });
    },
  });
  const linkBtn: React.CSSProperties = { background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" };

  const expiryNode = (tk: ApiToken) => {
    const ex = tokenExpiry(tk.expiresAt);
    if (ex.state === "none") return <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.tokenNoExpiry")}</span>;
    if (ex.state === "expired") return <Badge tone="danger">{t("settings.tokenExpired")}</Badge>;
    if (ex.state === "soon") return <Badge tone="warn">{ex.days === 1 ? t("settings.tokenDayLeft") : t("settings.tokenDaysLeft", { n: ex.days })}</Badge>;
    return <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.tokenExpires", { date: new Date(tk.expiresAt!).toLocaleDateString() })}</span>;
  };

  const field: React.CSSProperties = {
    padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)",
    borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit",
  };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("settings.apiTokens")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("settings.apiTokensDesc")}</p>

      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input style={field} placeholder={t("settings.tokenName")} aria-label={t("settings.tokenName")} value={name} onChange={(e) => setName(e.target.value)} required />

        <fieldset style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", margin: 0, minWidth: 0 }}>
          <legend style={{ fontSize: 12, fontWeight: 600, padding: "0 6px" }}>{t("settings.tokenScopes")}</legend>
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 8px" }}>{t("settings.tokenScopesHint")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleScopes.map((s) => {
              const checked = s.key === "read" || scopes.includes(s.key);
              return (
                <label key={s.key} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: s.key === "read" ? "default" : "pointer", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={s.key === "read"}
                    onChange={() => toggleScope(s.key)}
                    style={{ marginTop: 2, accentColor: "var(--c-a)" }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{t(`settings.scope${s.stem}`)}</span>
                    {s.ownerOnly && <span style={{ fontSize: 11, color: "var(--c-am)", marginLeft: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("settings.scopeOwnerOnly")}</span>}
                    <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t(`settings.scope${s.stem}Desc`)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <input
          style={{ ...field, maxWidth: 220 }}
          type="number"
          min={1}
          max={3650}
          step={1}
          placeholder={t("settings.tokenExpiryDays")}
          aria-label={t("settings.tokenExpiryDays")}
          value={expiryDays}
          onChange={(e) => setExpiryDays(e.target.value)}
        />

        <div>
          <Btn onClick={() => create.mutate()} disabled={create.isPending || !name}>{t("settings.createToken")}</Btn>
        </div>
      </form>

      {fresh && (
        <div style={{ marginTop: 12, padding: 10, background: "var(--c-el)", border: "1px solid var(--c-a)", borderRadius: "var(--r1)" }}>
          <div style={{ fontSize: 11, color: "var(--c-am)", marginBottom: 4 }}>{t("settings.tokenOnce")}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code className="mono" style={{ flex: 1, fontSize: 12, wordBreak: "break-all" }}>{fresh}</code>
            <CopyBtn text={fresh} label={t("settings.copy")} />
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        {tokens.map((tk) => {
          const expired = tokenExpiry(tk.expiresAt).state === "expired";
          const editing = renaming?.id === tk.id;
          return (
            <div key={tk.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, flexWrap: "wrap" }}>
              {editing ? (
                <form
                  onSubmit={(e) => { e.preventDefault(); if (renaming.name.trim()) rename.mutate({ id: tk.id, name: renaming.name.trim() }); }}
                  style={{ display: "flex", gap: 6, alignItems: "center" }}
                >
                  <input
                    autoFocus
                    style={{ ...field, padding: "4px 8px" }}
                    aria-label={t("settings.tokenRenameLabel")}
                    value={renaming.name}
                    maxLength={100}
                    onChange={(e) => setRenaming({ id: tk.id, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }}
                  />
                  <button type="submit" disabled={rename.isPending || !renaming.name.trim()} style={linkBtn}>{t("common.save")}</button>
                  <button type="button" onClick={() => setRenaming(null)} style={{ ...linkBtn, color: "var(--c-tx3)" }}>{t("common.cancel")}</button>
                </form>
              ) : (
                <span style={{ fontWeight: 600 }}>{tk.name}</span>
              )}
              <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{tk.prefix}…</span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {tk.scopes.map((sc) => (
                  <span key={sc} className="mono" style={{ fontSize: 11, padding: "1px 6px", borderRadius: 999, background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx3)" }}>{sc}</span>
                ))}
              </span>
              <span style={{ flex: 1 }} />
              {expiryNode(tk)}
              <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>
                {tk.lastUsedAt ? `${t("settings.tokenUsed")} ${new Date(tk.lastUsedAt).toLocaleDateString()}` : t("settings.tokenUnused")}
              </span>
              {!editing && (
                <button type="button" onClick={() => setRenaming({ id: tk.id, name: tk.name })} aria-label={t("settings.tokenRenameNamed", { name: tk.name })} style={linkBtn}>
                  {t("settings.tokenRename")}
                </button>
              )}
              {!expired && (
                <button
                  type="button"
                  disabled={rotate.isPending}
                  onClick={async () => { if (await confirm({ title: t("settings.tokenRotateTitle"), body: t("settings.tokenRotateBody", { name: tk.name }), danger: true })) rotate.mutate(tk.id); }}
                  aria-label={t("settings.tokenRotateNamed", { name: tk.name })}
                  style={linkBtn}
                >
                  {t("settings.tokenRotate")}
                </button>
              )}
              <button onClick={async () => { if (await confirm({ body: t("common.deleteNamedConfirm", { name: tk.name }), danger: true })) revoke.mutate(tk.id); }} style={{ background: "transparent", border: "none", color: "var(--c-r)", fontSize: 12, cursor: "pointer" }}>
                {t("settings.revoke")}
              </button>
            </div>
          );
        })}
        {tokens.length === 0 && <EmptyState icon={KeyRound} title={t("settings.noTokensTitle")}>{t("settings.noTokens")}</EmptyState>}
      </div>
    </Card>
  );
}
