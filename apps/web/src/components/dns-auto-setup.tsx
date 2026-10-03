"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { cleanDomain } from "../lib/domain";
import { useT } from "../i18n/provider";
import { Btn, Spinner } from "./ui";
import { Field, TextInput, Select } from "./form";
import { CopyBtn } from "./copy-row";
import { useToast } from "./toast";
import type { DnsAutoSetupResult } from "../lib/types";

const NEW = "__new__";
const cell: React.CSSProperties = { padding: "6px 10px", fontSize: 12, textAlign: "left" };
const mono: React.CSSProperties = { ...cell, fontFamily: "var(--font-mono, monospace)" };
const errText: React.CSSProperties = { color: "var(--c-r)", fontSize: 12, marginTop: 6 };

/**
 * One-click Cloudflare DNS auto-setup for a custom domain: pick (or connect) a team Cloudflare credential,
 * preview the records, then create them + wire the app domain in one call. Also offers a manual-records fallback
 * (copy-paste for any DNS provider) when Cloudflare isn't used. All records are DNS-only (no proxy).
 */
export function DnsAutoSetup({
  appId,
  teamId,
  domain,
  onApplied,
}: {
  appId: string;
  teamId?: string;
  domain: string;
  onApplied: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const host = cleanDomain(domain);

  const credsQ = useQuery({ queryKey: ["dnsCredentials"], queryFn: () => api.listDnsCredentials(), enabled: !!teamId });
  // Only trust the list once it has loaded AND we know the app's team — otherwise we'd briefly show other teams'
  // credential names and flash the "connect" form while loading.
  const credsReady = credsQ.isSuccess && !!teamId;
  const creds = credsReady ? (credsQ.data ?? []).filter((c) => c.provider === "cloudflare" && c.teamId === teamId) : [];

  const [credentialId, setCredentialId] = useState("");
  const [cName, setCName] = useState("");
  const [cToken, setCToken] = useState("");
  const [cAccount, setCAccount] = useState("");
  const [includeWww, setIncludeWww] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [plan, setPlan] = useState<DnsAutoSetupResult | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualHost, setManualHost] = useState("");

  const showConnect = credsReady && (creds.length === 0 || credentialId === NEW);
  const picked = credentialId && credentialId !== NEW ? credentialId : creds[0]?.id ?? "";
  const credId = showConnect ? "" : picked;

  // Any change to the inputs invalidates a previous preview and the opt-in overwrite — otherwise an overwrite
  // ticked for one domain could silently carry over and delete records on a different domain.
  useEffect(() => {
    setPlan(null);
    setOverwrite(false);
  }, [host, credId, includeWww]);

  const create = useMutation({
    mutationFn: () =>
      api.createDnsCredential({
        teamId: teamId as string,
        name: cName.trim(),
        provider: "cloudflare",
        apiToken: cToken.trim(),
        cfAccountId: cAccount.trim() || undefined,
      }),
    onSuccess: (cred) => {
      setCToken("");
      setCName("");
      setCAccount("");
      qc.invalidateQueries({ queryKey: ["dnsCredentials"] });
      setCredentialId(cred.id);
    },
  });

  const preview = useMutation({
    mutationFn: () => api.autoSetupDomain(appId, { domain: host, credentialId: credId || undefined, includeWww, overwrite, dryRun: true }),
    onSuccess: (res) => setPlan(res),
  });
  const apply = useMutation({
    mutationFn: () => api.autoSetupDomain(appId, { domain: host, credentialId: credId || undefined, includeWww, overwrite }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["app", appId] }), qc.invalidateQueries({ queryKey: ["apps"] })]);
      toast(t("apps.dnsAutoApplied"), "success");
      onApplied();
    },
  });

  // The manual-records fetch is pinned to the host at the moment the panel is opened (not the live input) so it
  // does not refetch on every keystroke in the domain field.
  const manualQ = useQuery({
    queryKey: ["manualDns", appId, manualHost, includeWww],
    queryFn: () => api.getManualDnsRecords(appId, manualHost, includeWww),
    enabled: showManual && !!manualHost,
  });
  const toggleManual = () => {
    if (showManual) {
      setShowManual(false);
    } else {
      setManualHost(host);
      setShowManual(true);
    }
  };

  const showOverwrite = overwrite || (plan?.records ?? []).some((r) => r.action === "conflict");
  const runnable = !!host && !showConnect;

  const options = [...creds.map((c) => ({ value: c.id, label: c.name })), { value: NEW, label: t("apps.dnsAutoAddNew") }];

  return (
    <div style={{ marginTop: 12, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)" }}>{t("apps.dnsAutoTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "4px 0 10px" }}>{t("apps.dnsAutoDesc")}</p>

      {!host && <p style={{ fontSize: 12, color: "var(--c-am)" }}>{t("apps.dnsAutoNoDomain")}</p>}
      {credsQ.isError && <div style={errText}>{(credsQ.error as Error).message}</div>}
      {!credsReady && !credsQ.isError && <Spinner />}

      {credsReady && creds.length > 0 && (
        <Field label={t("apps.dnsAutoCredential")} htmlFor="dns-cred">
          <Select id="dns-cred" value={credentialId || creds[0]?.id} onChange={setCredentialId} options={options} placeholder={t("apps.dnsAutoPickCredential")} />
        </Field>
      )}

      {showConnect && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: creds.length > 0 ? 8 : 0 }}>
          <Field label={t("apps.dnsAutoName")} htmlFor="dns-c-name">
            <TextInput id="dns-c-name" value={cName} placeholder={t("apps.dnsAutoNamePlaceholder")} onChange={(e) => setCName(e.target.value)} />
          </Field>
          <Field label={t("apps.dnsAutoApiToken")} htmlFor="dns-c-token" hint={t("apps.dnsAutoApiTokenHint")}>
            <TextInput id="dns-c-token" type="password" autoComplete="new-password" value={cToken} onChange={(e) => setCToken(e.target.value)} />
          </Field>
          <Field label={t("apps.dnsAutoAccountId")} htmlFor="dns-c-acct">
            <TextInput id="dns-c-acct" value={cAccount} onChange={(e) => setCAccount(e.target.value)} />
          </Field>
          <div>
            <Btn onClick={() => create.mutate()} disabled={create.isPending || !teamId || !cName.trim() || !cToken.trim()}>
              {create.isPending ? "…" : t("apps.dnsAutoSaveCredential")}
            </Btn>
          </div>
          {create.isError && <div style={errText}>{(create.error as Error).message}</div>}
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0", fontSize: 13, color: "var(--c-tx2)" }}>
        <input type="checkbox" checked={includeWww} onChange={(e) => setIncludeWww(e.target.checked)} />
        {t("apps.dnsAutoIncludeWww")}
      </label>

      {showOverwrite && (
        <div style={{ margin: "6px 0" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--c-tx2)" }}>
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => {
                setOverwrite(e.target.checked);
                setPlan(null); // the shown plan no longer reflects the overwrite choice — re-preview to see it
              }}
            />
            {t("apps.dnsAutoOverwrite")}
          </label>
          <p style={{ fontSize: 12, color: "var(--c-am)", margin: "4px 0 0" }}>{t("apps.dnsAutoConflictNote")}</p>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <Btn variant="ghost" onClick={() => preview.mutate()} disabled={!runnable || preview.isPending}>
          {preview.isPending ? "…" : t("apps.dnsAutoPreview")}
        </Btn>
        <Btn onClick={() => apply.mutate()} disabled={!runnable || apply.isPending}>
          {apply.isPending ? "…" : t("apps.dnsAutoApply")}
        </Btn>
      </div>
      {preview.isError && <div style={errText}>{(preview.error as Error).message}</div>}
      {apply.isError && <div style={errText}>{(apply.error as Error).message}</div>}

      {plan && plan.records.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
          <thead>
            <tr style={{ color: "var(--c-tx3)" }}>
              <th style={cell}>{t("apps.dnsAutoColType")}</th>
              <th style={cell}>{t("apps.dnsAutoColName")}</th>
              <th style={cell}>{t("apps.dnsAutoColValue")}</th>
              <th style={cell}>{t("apps.dnsAutoColAction")}</th>
            </tr>
          </thead>
          <tbody>
            {plan.records.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--c-bd)", color: r.action === "conflict" ? "var(--c-r)" : "var(--c-tx2)" }}>
                <td style={cell}>{r.type}</td>
                <td style={mono}>{r.name}</td>
                <td style={mono}>{r.content ?? ""}</td>
                <td style={cell}>{t(`apps.dnsAutoAction_${r.action}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 12, borderTop: "1px solid var(--c-bd)", paddingTop: 10 }}>
        <Btn variant="ghost" onClick={toggleManual} disabled={!host}>
          {t("apps.dnsAutoManualToggle")}
        </Btn>
        {showManual && (
          <div style={{ marginTop: 8 }}>
            <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px" }}>{t("apps.dnsAutoManualDesc")}</p>
            {manualQ.isError && <div style={errText}>{(manualQ.error as Error).message}</div>}
            {manualQ.data && (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--c-tx3)" }}>
                    <th style={cell}>{t("apps.dnsAutoColType")}</th>
                    <th style={cell}>{t("apps.dnsAutoColName")}</th>
                    <th style={cell}>{t("apps.dnsAutoColValue")}</th>
                    <th style={cell} />
                  </tr>
                </thead>
                <tbody>
                  {manualQ.data.records.map((r, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--c-bd)", color: "var(--c-tx2)" }}>
                      <td style={cell}>{r.type}</td>
                      <td style={mono}>{r.name}</td>
                      <td style={mono}>{r.content}</td>
                      <td style={cell}>
                        <CopyBtn text={r.content} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
