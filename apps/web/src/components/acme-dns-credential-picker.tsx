"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";

/**
 * Pick a team DNS credential to use for this server's DNS-01 certificates. Picking one COPIES its token onto the
 * server (it is not a live link), so a rotated credential does not reach the server until it is re-applied.
 * `value` is the picked credential id ("" = none); `linkedId` is the credential the server was last set up from.
 */
export function AcmeDnsCredentialPicker({
  teamId,
  value,
  onChange,
  linkedId,
  onReapply,
  reapplying = false,
}: {
  teamId: string;
  value: string;
  onChange: (id: string) => void;
  linkedId: string | null;
  onReapply: () => void;
  reapplying?: boolean;
}) {
  const t = useT();
  const { data: all = [] } = useQuery({ queryKey: ["dns-credentials"], queryFn: () => api.listDnsCredentials() });
  const creds = all.filter((c) => c.teamId === teamId);
  const picked = creds.find((c) => c.id === value);
  const canReapply = !!linkedId && value === linkedId;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
        {t("servers.acmeDns.label")}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit" }}
        >
          <option value="">{t("servers.acmeDns.none")}</option>
          {creds.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>)}
        </select>
      </label>
      {creds.length === 0 && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("servers.acmeDns.noCredentials")}</span>}
      {picked && (
        <span style={{ fontSize: 11, color: picked.lastVerifiedAt && picked.canWrite ? "var(--c-tx3)" : "var(--c-am)" }}>
          {!picked.canWrite
            ? t("servers.acmeDns.readOnly")
            : picked.lastVerifiedAt
              ? t("servers.acmeDns.coverageVerified", { date: new Date(picked.lastVerifiedAt).toLocaleDateString() })
              : t("servers.acmeDns.coverageUnverified")}
        </span>
      )}
      <span style={{ fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("servers.acmeDns.tokenCopied")}</span>
      <div>
        <Btn variant="ghost" onClick={onReapply} disabled={!canReapply || reapplying} loading={reapplying}>{t("servers.acmeDns.reapply")}</Btn>
        {linkedId && value !== linkedId && <span style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: 8 }}>{t("servers.acmeDns.reapplyHint")}</span>}
      </div>
    </div>
  );
}
