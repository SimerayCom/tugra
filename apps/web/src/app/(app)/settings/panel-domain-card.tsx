"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Btn, Card } from "../../../components/ui";
import { Field, TextInput } from "../../../components/form";
import type { PanelDomainStatus } from "../../../lib/types";

// A bare hostname (no scheme, port, path, wildcard or IP literal) — the same shape the hub validates.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ACTIVE = new Set(["proxy", "certificate", "switching"]);

/**
 * Owner-only panel domain (Settings → Instance). Set / change / remove the domain the panel is served on: the hub
 * configures the proxy, waits for the Let's Encrypt certificate (HTTP-01, no token), THEN switches the public URL via
 * the update helper — so a failed certificate rolls back with the old address still working. The change runs in the
 * background; this card polls it.
 */
export function PanelDomainCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [ip, setIp] = useState("");
  const [needsIp, setNeedsIp] = useState(false);
  const [touched, setTouched] = useState(false);

  const { data } = useQuery({
    queryKey: ["panelDomain"],
    queryFn: () => api.getPanelDomain(),
    enabled: isOwner,
    refetchOnWindowFocus: false,
    // Poll while a change is running; while the hub is being recreated the request fails and the poll just continues.
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.job.phase) ? 3000 : q.state.error ? 5000 : false),
    retry: false,
  });

  const active = !!data && ACTIVE.has(data.job.phase);
  useEffect(() => {
    if (data?.job.phase === "done") qc.invalidateQueries({ queryKey: ["panelTls"] });
  }, [data?.job.phase, qc]);

  const started = (st: PanelDomainStatus) => {
    qc.setQueryData(["panelDomain"], st);
    toast(t("settings.panelDomain_started"), "success");
  };
  const failed = (e: unknown, fallback: string) => toast(e instanceof Error ? e.message : fallback, "error");

  const setMut = useMutation({
    mutationFn: () => api.setPanelDomain({ domain: domain.trim().toLowerCase(), ...(email.trim() ? { acmeEmail: email.trim() } : {}) }),
    onSuccess: started,
    onError: (e) => failed(e, t("settings.panelDomain_startFailed")),
  });
  const removeMut = useMutation({
    mutationFn: () => api.removePanelDomain(ip.trim() ? { publicIp: ip.trim() } : {}),
    onSuccess: (st) => {
      setNeedsIp(false);
      started(st);
    },
    onError: (e) => {
      if (e instanceof Error && /publicIp/.test(e.message)) setNeedsIp(true);
      failed(e, t("settings.panelDomain_startFailed"));
    },
  });

  if (!isOwner) return null;

  const normalized = domain.trim().toLowerCase();
  const domainValid = DOMAIN_RE.test(normalized);
  const job = data?.job;
  const busy = setMut.isPending || removeMut.isPending || active;
  const hasDomain = data?.mode === "domain";

  const modeText = !data
    ? ""
    : data.mode === "domain"
      ? t("settings.panelDomain_modeDomain", { url: data.url ?? "" })
      : data.mode === "ip"
        ? t("settings.panelDomain_modeIp", { url: data.url ?? "" })
        : t("settings.panelDomain_modePort", { url: data.url ?? "" });

  const box = { fontSize: 12, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "9px 11px", marginTop: 12, lineHeight: 1.5 } as const;
  const target = job?.action === "remove" ? data?.url ?? "" : job?.domain ? `https://${job.domain}` : "";
  const steps: Array<{ phase: string; label: string }> =
    job?.action === "remove"
      ? [
          { phase: "proxy", label: t("settings.panelDomain_removeProxy") },
          { phase: "switching", label: t("settings.panelDomain_stepSwitching") },
        ]
      : [
          { phase: "proxy", label: t("settings.panelDomain_stepProxy") },
          { phase: "certificate", label: t("settings.panelDomain_stepCertificate") },
          { phase: "switching", label: t("settings.panelDomain_stepSwitching") },
        ];
  const order = ["proxy", "certificate", "switching", "done"];

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600 }}>{t("settings.panelDomain")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 12px", lineHeight: 1.5 }}>{t("settings.panelDomain_desc")}</p>
      {modeText && <div style={{ fontSize: 13, color: "var(--c-tx)", marginBottom: 4 }}>{modeText}</div>}

      {data && !data.localServerOnline && <div style={box}>{t("settings.panelDomain_serverOffline")}</div>}

      {active && job && (
        <div role="status" aria-live="polite" style={box}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {steps.map((s) => {
              const here = order.indexOf(job.phase);
              const mine = order.indexOf(s.phase);
              const state = mine < here ? "done" : mine === here ? "now" : "todo";
              return (
                <li key={s.phase} style={{ color: state === "todo" ? "var(--c-tx3)" : "var(--c-tx)", fontWeight: state === "now" ? 600 : 400 }}>
                  {state === "done" ? "✓ " : state === "now" ? "… " : "· "}
                  {s.label}
                </li>
              );
            })}
          </ul>
          {job.phase === "switching" && target && (
            <div style={{ marginTop: 8 }}>
              <div>{t("settings.panelDomain_switchingNote", { url: target })}</div>
              <a href={target} style={{ color: "var(--c-ac, var(--c-tx))", fontWeight: 600 }}>
                {t("settings.panelDomain_open", { url: target })}
              </a>
            </div>
          )}
        </div>
      )}

      {job?.phase === "done" && job.action === "set" && job.domain && (
        <div role="status" style={box}>
          <div>{t("settings.panelDomain_doneNote", { url: `https://${job.domain}` })}</div>
          <a href={`https://${job.domain}`} style={{ color: "var(--c-ac, var(--c-tx))", fontWeight: 600 }}>
            {t("settings.panelDomain_open", { url: `https://${job.domain}` })}
          </a>
        </div>
      )}

      {job?.phase === "failed" && (
        <div role="alert" style={{ ...box, borderColor: "var(--c-r)" }}>
          <div style={{ fontWeight: 600 }}>{t("settings.panelDomain_failed")}</div>
          <div>{t(`settings.panelDomain_fail_${job.code ?? "interrupted"}`, { error: job.error ?? "" })}</div>
          {job.detail && <div style={{ marginTop: 6, color: "var(--c-tx3)", wordBreak: "break-word" }}>{t("settings.panelDomain_detail", { detail: job.detail })}</div>}
        </div>
      )}

      {!active && (
        <form
          style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (domainValid && !busy) setMut.mutate();
          }}
        >
          <Field
            label={t("settings.panelDomain_label")}
            htmlFor="panel-domain"
            hint={t("settings.panelDomain_dnsHint")}
            error={touched && !domainValid ? t("settings.panelDomain_invalid") : undefined}
          >
            <TextInput id="panel-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={t("settings.panelDomain_placeholder")} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t("settings.panelDomain_emailLabel")} htmlFor="panel-domain-email" hint={t("settings.panelDomain_emailHint")}>
            <TextInput id="panel-domain-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </Field>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn type="submit" disabled={busy || !data?.localServerOnline || !normalized}>
              {setMut.isPending ? "…" : job?.phase === "failed" ? t("settings.panelDomain_tryAgain") : hasDomain ? t("settings.panelDomain_change") : t("settings.panelDomain_set")}
            </Btn>
            {hasDomain && (
              <Btn
                variant="ghost"
                disabled={busy || !data?.localServerOnline}
                onClick={() => {
                  if (window.confirm(t("settings.panelDomain_removeConfirm", { domain: data?.domain ?? "" }))) removeMut.mutate();
                }}
              >
                {removeMut.isPending ? "…" : t("settings.panelDomain_remove")}
              </Btn>
            )}
          </div>
          {needsIp && (
            <Field label={t("settings.panelDomain_ipLabel")} htmlFor="panel-domain-ip" hint={t("settings.panelDomain_removeNeedsIp")}>
              <TextInput id="panel-domain-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.9" autoComplete="off" inputMode="decimal" />
            </Field>
          )}
        </form>
      )}
    </Card>
  );
}
