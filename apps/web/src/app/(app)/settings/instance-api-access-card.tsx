"use client";

import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";

/**
 * Owner-only panel to control token (PAT) API access: a master kill-switch and an IP/CIDR allowlist.
 * Rendered for every settings visitor but returns null unless the current user owns the instance — the
 * hub enforces the same (session + owner guard), this only decides visibility.
 */
export function InstanceApiAccessCard() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  const { data } = useQuery({
    queryKey: ["instanceSettings"],
    queryFn: () => api.getInstanceSettings(),
    enabled: isOwner,
    // This is an editable form seeded from `data`; a focus refetch mid-edit would clobber the input.
    refetchOnWindowFocus: false,
  });

  const [enabled, setEnabled] = useState(true);
  const [ipsText, setIpsText] = useState("");
  useEffect(() => {
    if (data) {
      setEnabled(data.apiEnabled);
      setIpsText(data.apiAllowedIps.join("\n"));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateInstanceSettings({
        apiEnabled: enabled,
        apiAllowedIps: ipsText.split("\n").map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: (res) => {
      setEnabled(res.apiEnabled);
      setIpsText(res.apiAllowedIps.join("\n"));
      qc.invalidateQueries({ queryKey: ["instanceSettings"] });
    },
  });

  if (!isOwner) return null;

  const field: React.CSSProperties = {
    width: "100%", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)",
    borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "var(--font-mono, monospace)",
    boxSizing: "border-box", resize: "vertical",
  };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("settings.apiAccess")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("settings.apiAccessDesc")}</p>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ marginTop: 2, accentColor: "var(--c-a)" }} />
        <span>
          <span style={{ fontWeight: 600 }}>{t("settings.apiEnabled")}</span>
          <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.apiEnabledHint")}</span>
        </span>
      </label>

      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t("settings.apiAllowedIps")}</div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 6 }}>{t("settings.apiAllowedIpsHint")}</div>
      <textarea
        aria-label={t("settings.apiAllowedIps")}
        style={{ ...field, minHeight: 84 }}
        placeholder={"203.0.113.7\n10.0.0.0/8\n2001:db8::/32"}
        value={ipsText}
        onChange={(e) => setIpsText(e.target.value)}
      />

      {save.isError && (
        <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>
          {save.error instanceof Error ? save.error.message : t("settings.apiSaveFailed")}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("settings.apiSave")}</Btn>
      </div>
    </Card>
  );
}
