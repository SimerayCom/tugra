"use client";

import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import type { ApiTokenScope } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Btn } from "../../../components/ui";

/** Grantable scopes in display order, with the i18n key stem and whether it's owner-only. `read` is the
 *  baseline every token carries (checkbox is checked + locked). */
export const SCOPE_OPTIONS: { key: ApiTokenScope; stem: string; ownerOnly: boolean }[] = [
  { key: "read", stem: "Read", ownerOnly: false },
  { key: "write", stem: "Write", ownerOnly: false },
  { key: "deploy", stem: "Deploy", ownerOnly: false },
  { key: "read:secrets", stem: "ReadSecrets", ownerOnly: true },
  { key: "admin", stem: "Admin", ownerOnly: true },
];

/** The expiry choices. `null` = never. Order is display order; the first is the default. */
export const EXPIRY_CHOICES: { value: string; days: number | null; label: string }[] = [
  { value: "90", days: 90, label: "tokenExpiry90" },
  { value: "30", days: 30, label: "tokenExpiry30" },
  { value: "365", days: 365, label: "tokenExpiry365" },
  { value: "never", days: null, label: "tokenExpiryNever" },
];

export const field: React.CSSProperties = {
  padding: "8px 10px", minHeight: 44, boxSizing: "border-box", background: "var(--c-el)", border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit",
};

/** Create form. `mcp` is the preset: a read-only token named "MCP" (scopes are fixed, so no picker). */
export function ApiTokenForm({
  mcp,
  isOwner,
  onCreated,
  onCancel,
}: {
  mcp: boolean;
  isOwner: boolean;
  onCreated: (token: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(mcp ? t("settings.tokenMcpName") : "");
  const [scopes, setScopes] = useState<ApiTokenScope[]>(["read"]);
  const [expiry, setExpiry] = useState(EXPIRY_CHOICES[0].value);

  const visibleScopes = SCOPE_OPTIONS.filter((s) => isOwner || !s.ownerOnly);
  const toggleScope = (key: ApiTokenScope) => {
    if (key === "read") return; // baseline, always on
    setScopes((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };

  const create = useMutation({
    mutationFn: () => {
      // Keep display order and drop any scope the current user can't grant (owner-only guard, defence in depth).
      const granted: ApiTokenScope[] = mcp ? ["read"] : visibleScopes.filter((s) => scopes.includes(s.key)).map((s) => s.key);
      const days = EXPIRY_CHOICES.find((c) => c.value === expiry)?.days ?? null;
      return days ? api.createApiToken(name.trim(), granted, days) : api.createApiToken(name.trim(), granted);
    },
    onSuccess: (res) => onCreated(res.token),
  });

  const idp = mcp ? "tok-mcp" : "tok-new";
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600 };

  return (
    <form
      aria-label={mcp ? t("settings.tokenMcpTitle") : t("settings.tokenFormTitle")}
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}
      style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12, padding: 14, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)" }}
    >
      {mcp && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("settings.tokenMcpHint")}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor={`${idp}-name`} style={label}>{t("settings.tokenNameLabel")}</label>
        <input id={`${idp}-name`} style={{ ...field, background: "var(--c-bg)" }} placeholder={t("settings.tokenName")} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
      </div>

      {!mcp && (
        <fieldset style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", margin: 0, minWidth: 0 }}>
          <legend style={{ fontSize: 12, fontWeight: 600, padding: "0 6px" }}>{t("settings.tokenScopes")}</legend>
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 8px" }}>{t("settings.tokenScopesHint")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {visibleScopes.map((s) => {
              const checked = s.key === "read" || scopes.includes(s.key);
              return (
                <label key={s.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: s.key === "read" ? "default" : "pointer", fontSize: 13, minHeight: 44, padding: "6px 0" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={s.key === "read"}
                    onChange={() => toggleScope(s.key)}
                    style={{ marginTop: 3, width: 18, height: 18, accentColor: "var(--c-a)" }}
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
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor={`${idp}-expiry`} style={label}>{t("settings.tokenExpiryDays")}</label>
        <select id={`${idp}-expiry`} style={{ ...field, background: "var(--c-bg)", maxWidth: 260 }} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          {EXPIRY_CHOICES.map((c) => <option key={c.value} value={c.value}>{t(`settings.${c.label}`)}</option>)}
        </select>
        {expiry === "never" && <span role="note" style={{ fontSize: 11, color: "var(--c-am)" }}>{t("settings.tokenExpiryNeverHint")}</span>}
      </div>

      {create.isError && (
        <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>
          {create.error instanceof Error && create.error.message ? create.error.message : t("settings.tokenCreateFailed")}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn type="submit" loading={create.isPending} disabled={!name.trim()} style={{ minHeight: 44 }}>
          {mcp ? t("settings.tokenMcpCreate") : t("settings.createToken")}
        </Btn>
        <Btn variant="ghost" onClick={onCancel} style={{ minHeight: 44 }}>{t("common.cancel")}</Btn>
      </div>
    </form>
  );
}
