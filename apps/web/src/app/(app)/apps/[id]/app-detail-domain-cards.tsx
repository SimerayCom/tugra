"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useConfirm } from "../../../../components/confirm";
import { useToast } from "../../../../components/toast";
import { Btn, SectionCard } from "../../../../components/ui";
import { useUnsavedChanges } from "../../../../hooks/useUnsavedChanges";
import { useT } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { basicAuthSaveRemovesAll, canSaveBasicAuth, completeBasicAuthRows, hasIncompleteBasicAuthRow } from "../../../../lib/basic-auth";
import { envField } from "./app-detail-shared";

/** Protect a routed app with HTTP Basic Auth. Passwords are write-only (the API returns only usernames), so
 *  the card lists who's protected and edits by REPLACING the whole set — saving an empty list removes it. */
export function BasicAuthCard({ id, usernames }: { id: string; usernames: string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<{ user: string; password: string }[]>([]);
  const save = useMutation({
    mutationFn: (users: { user: string; password: string }[]) => api.setAppBasicAuth(id, users),
    onSuccess: () => { setRows([]); qc.invalidateQueries({ queryKey: ["app", id] }); toast(t("apps.saved"), "success"); },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.sourceSaveFailed"), "error"),
  });
  const incomplete = hasIncompleteBasicAuthRow(rows);
  const onSave = async () => {
    // A save with no complete row while users exist removes ALL protection — confirm before going public.
    if (basicAuthSaveRemovesAll(rows, usernames.length) && !(await confirm({ title: t("apps.basicAuth"), body: t("apps.basicAuthRemoveConfirm"), danger: true }))) return;
    save.mutate(completeBasicAuthRows(rows));
  };
  return (
    <SectionCard title={t("apps.basicAuth")} desc={t("apps.basicAuthDesc")}>
      {usernames.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--c-tx2)", marginBottom: 10 }}>{t("apps.basicAuthCurrent", { users: usernames.join(", ") })}</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => {
          const userMissing = !!r.password && !r.user.trim();
          const pwMissing = !!r.user.trim() && !r.password;
          return (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...envField, flex: 1, ...(userMissing ? { borderColor: "var(--c-r)" } : {}) }} placeholder={t("apps.basicAuthUser")} value={r.user} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, user: e.target.value } : x)))} aria-label={t("apps.basicAuthUser")} aria-invalid={userMissing} />
              <input style={{ ...envField, flex: 1, ...(pwMissing ? { borderColor: "var(--c-r)" } : {}) }} type="password" placeholder={t("apps.basicAuthPassword")} value={r.password} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, password: e.target.value } : x)))} aria-label={t("apps.basicAuthPassword")} aria-invalid={pwMissing} />
              <Btn variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>{t("apps.remove")}</Btn>
            </div>
          );
        })}
      </div>
      {incomplete && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("apps.basicAuthIncomplete")}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { user: "", password: "" }])}>{t("apps.basicAuthAdd")}</Btn>
        <div style={{ flex: 1 }} />
        <Btn onClick={onSave} disabled={save.isPending || !canSaveBasicAuth(rows, usernames.length)}>{t("apps.save")}</Btn>
      </div>
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("apps.basicAuthReplaceNote")}</p>
    </SectionCard>
  );
}

export function RedirectsCard({ id, redirects }: { id: string; redirects: { regex: string; replacement: string; permanent: boolean }[] }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<{ regex: string; replacement: string; permanent: boolean }[]>(redirects);
  const save = useMutation({
    mutationFn: () =>
      api.setAppRedirects(
        id,
        rows.map((r) => ({ regex: r.regex.trim(), replacement: r.replacement.trim(), permanent: r.permanent })).filter((r) => r.regex && r.replacement),
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["app", id] }); toast(t("apps.saved"), "success"); },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.sourceSaveFailed"), "error"),
  });
  const patch = (i: number, p: Partial<{ regex: string; replacement: string; permanent: boolean }>) =>
    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <SectionCard title={t("apps.redirects")} desc={t("apps.redirectsDesc")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input className="mono" style={{ ...envField, flex: "2 1 200px" }} placeholder={t("apps.redirectsRegex")} value={r.regex} onChange={(e) => patch(i, { regex: e.target.value })} aria-label={t("apps.redirectsRegex")} />
            <input className="mono" style={{ ...envField, flex: "2 1 200px" }} placeholder={t("apps.redirectsReplacement")} value={r.replacement} onChange={(e) => patch(i, { replacement: e.target.value })} aria-label={t("apps.redirectsReplacement")} />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx2)", whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={r.permanent} onChange={(e) => patch(i, { permanent: e.target.checked })} />
              {t("apps.redirectsPermanent")}
            </label>
            <Btn variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>{t("apps.remove")}</Btn>
          </div>
        ))}
        {rows.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.redirectsEmpty")}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { regex: "", replacement: "", permanent: true }])}>{t("apps.redirectsAdd")}</Btn>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("apps.redirectsHint")}</p>
    </SectionCard>
  );
}

// Extra alias hostnames (served alongside the primary domain). A textarea, one host per line (also accepts
// Per-service domains (COMPOSE): route a named service on a port to its own hostname. Replace-set on save.
export function ServiceDomainsCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["serviceDomains", id], queryFn: () => api.getServiceDomains(id) });
  const [rows, setRows] = useState<{ service: string; hostname: string; port: string }[]>([]);
  useEffect(() => {
    if (data) setRows(data.map((d) => ({ service: d.service, hostname: d.hostname, port: String(d.port) })));
  }, [data]);
  const setRow = (i: number, patch: Partial<{ service: string; hostname: string; port: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = useMutation({
    mutationFn: () =>
      api.setServiceDomains(id, rows.filter((r) => r.service.trim() && r.hostname.trim()).map((r) => ({ service: r.service.trim(), hostname: r.hostname.trim().toLowerCase(), port: Number(r.port) || 80 }))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["serviceDomains", id] }); qc.invalidateQueries({ queryKey: ["app", id] }); },
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.serviceDomainsSaveFailed"), "error"),
  });
  return (
    <SectionCard title={t("apps.serviceDomains")} desc={t("apps.serviceDomainsDesc")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input style={{ ...envField, width: 150 }} placeholder={t("apps.serviceDomainsService")} value={r.service} onChange={(e) => setRow(i, { service: e.target.value })} aria-label={t("apps.serviceDomainsService")} />
            <input style={{ ...envField, flex: "1 1 200px" }} placeholder={t("apps.serviceDomainsHost")} value={r.hostname} onChange={(e) => setRow(i, { hostname: e.target.value })} aria-label={t("apps.serviceDomainsHost")} />
            <input style={{ ...envField, width: 90 }} type="number" placeholder={t("apps.serviceDomainsPort")} value={r.port} onChange={(e) => setRow(i, { port: e.target.value })} aria-label={t("apps.serviceDomainsPort")} />
            <button aria-label={t("common.remove")} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ ...envField, cursor: "pointer", color: "var(--c-r)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X size={14} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { service: "", hostname: "", port: "80" }])}>{t("apps.serviceDomainsAdd")}</Btn>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.serviceDomainsRedeploy")}</div>}
    </SectionCard>
  );
}

// comma/space separated); replace-set on save, applied on the next deploy.
export function ExtraDomainsCard({ id, extraDomains }: { id: string; extraDomains: string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(extraDomains.join("\n"));
  const parse = (s: string) => Array.from(new Set(s.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean)));
  const save = useMutation({
    mutationFn: () => api.setAppExtraDomains(id, parse(value)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.extraDomainsSaveFailed"), "error"),
  });
  return (
    <SectionCard title={t("apps.extraDomains")} desc={t("apps.extraDomainsDesc")}>
      <textarea
        className="mono"
        style={{ ...envField, width: "100%", minHeight: 80, resize: "vertical" }}
        value={value}
        placeholder={t("apps.extraDomainsPlaceholder")}
        onChange={(e) => setValue(e.target.value)}
        aria-label={t("apps.extraDomains")}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.extraDomainsRedeploy")}</div>}
    </SectionCard>
  );
}

export function NetworkAliasesCard({ id, aliases }: { id: string; aliases: string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [text, setText] = useState(aliases.join("\n"));
  useEffect(() => { setText(aliases.join("\n")); }, [aliases]);
  const parse = (s: string) => Array.from(new Set(s.split(/[\n,]/).map((l) => l.trim().toLowerCase()).filter(Boolean)));
  const dirty = parse(text).join("\n") !== aliases.join("\n");
  const save = useMutation({
    mutationFn: () => api.setAppNetworkAliases(id, parse(text)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  useUnsavedChanges(dirty && !save.isPending);
  return (
    <SectionCard title={t("apps.networkAliases")} desc={t("apps.networkAliasesDesc")}>
      <textarea
        className="mono"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        placeholder={"api\ninternal-cache"}
        aria-label={t("apps.networkAliases")}
        style={{ width: "100%", minHeight: 64, maxHeight: 160, resize: "vertical", fontSize: 12, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <Btn onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{t("apps.save")}</Btn>
        <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.networkAliasesHint")}</span>
      </div>
      {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(save.error as Error).message}</div>}
    </SectionCard>
  );
}

export function DomainOptionsCard({
  id,
  domain,
  https,
  domainRedirect,
  securityHeaders,
  gzip,
  forwardAuth,
  ipAllowlist,
  pathPrefix,
  stripPrefix,
  rateLimit,
}: {
  id: string;
  domain: string;
  https: boolean;
  domainRedirect: "www" | "root" | null;
  securityHeaders: boolean;
  gzip: boolean;
  forwardAuth: string | null;
  ipAllowlist: string[];
  pathPrefix: string | null;
  stripPrefix: boolean;
  rateLimit: { average: number; burst: number; period: "1s" | "1m" | "1h" } | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [redirect, setRedirect] = useState<string>(domainRedirect ?? "");
  const [sec, setSec] = useState(securityHeaders);
  const [gz, setGz] = useState(gzip);
  const [fa, setFa] = useState(forwardAuth ?? "");
  const [ips, setIps] = useState(ipAllowlist.join("\n"));
  const [pfx, setPfx] = useState(pathPrefix ?? "");
  const [strip, setStrip] = useState(stripPrefix);
  const [rlOn, setRlOn] = useState(!!rateLimit);
  const [rlAvg, setRlAvg] = useState(String(rateLimit?.average ?? 60));
  const [rlBurst, setRlBurst] = useState(String(rateLimit?.burst ?? 30));
  const [rlPeriod, setRlPeriod] = useState<"1s" | "1m" | "1h">(rateLimit?.period ?? "1m");
  const save = useMutation({
    mutationFn: () =>
      api.setAppDomainOptions(id, {
        domainRedirect: redirect ? (redirect as "www" | "root") : null,
        securityHeaders: sec,
        gzip: gz,
        forwardAuth: fa.trim() || null,
        ipAllowlist: ips.split("\n").map((l) => l.trim()).filter(Boolean),
        pathPrefix: pfx.trim() || null,
        stripPrefix: strip,
        rateLimit: rlOn ? { average: Math.max(1, Number(rlAvg) || 0), burst: Math.max(1, Number(rlBurst) || 0), period: rlPeriod } : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });

  return (
    <SectionCard title={t("apps.domainOptions")} desc={t("apps.domainOptionsDesc")}>
      <div className="mono" style={{ fontSize: 12, color: "var(--c-tx2)", marginBottom: 10 }}>
        {https ? "https://" : "http://"}{domain}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, minWidth: 200 }} value={redirect} onChange={(e) => setRedirect(e.target.value)} aria-label={t("apps.redirectLabel")}>
          <option value="">{t("apps.redirectNone")}</option>
          <option value="root">{t("apps.redirectRoot")}</option>
          <option value="www">{t("apps.redirectWww")}</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={sec} onChange={(e) => setSec(e.target.checked)} />
          {t("apps.securityHeaders")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }} title={t("apps.gzipDesc")}>
          <input type="checkbox" checked={gz} onChange={(e) => setGz(e.target.checked)} />
          {t("apps.gzip")}
        </label>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.forwardAuth")}</div>
        <input
          style={{ ...envField, width: "100%" }}
          placeholder="https://auth.example.com/api/verify?rd=https://auth.example.com"
          value={fa}
          onChange={(e) => setFa(e.target.value)}
          aria-label={t("apps.forwardAuth")}
        />
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "4px 0 0" }}>{t("apps.forwardAuthDesc")}</p>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.ipAllowlist")}</div>
        <textarea
          className="mono"
          value={ips}
          spellCheck={false}
          onChange={(e) => setIps(e.target.value)}
          placeholder={"203.0.113.4\n10.0.0.0/8\n2001:db8::/32"}
          aria-label={t("apps.ipAllowlist")}
          style={{ width: "100%", minHeight: 72, maxHeight: 180, resize: "vertical", fontSize: 12, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
        />
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "4px 0 0" }}>{t("apps.ipAllowlistDesc")}</p>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.pathPrefix")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            style={{ ...envField, minWidth: 200 }}
            placeholder="/api"
            value={pfx}
            spellCheck={false}
            onChange={(e) => setPfx(e.target.value)}
            aria-label={t("apps.pathPrefix")}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
            <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} />
            {t("apps.stripPrefix")}
          </label>
        </div>
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "4px 0 0" }}>{t("apps.pathPrefixDesc")}</p>
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={rlOn} onChange={(e) => setRlOn(e.target.checked)} />
          {t("apps.rateLimit")}
        </label>
        {rlOn && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
            <input style={{ ...envField, width: 110 }} type="number" min={1} value={rlAvg} onChange={(e) => setRlAvg(e.target.value)} aria-label={t("apps.rateLimitAverage")} placeholder={t("apps.rateLimitAverage")} />
            <input style={{ ...envField, width: 110 }} type="number" min={1} value={rlBurst} onChange={(e) => setRlBurst(e.target.value)} aria-label={t("apps.rateLimitBurst")} placeholder={t("apps.rateLimitBurst")} />
            <select style={{ ...envField, minWidth: 110 }} value={rlPeriod} onChange={(e) => setRlPeriod(e.target.value as "1s" | "1m" | "1h")} aria-label={t("apps.rateLimitPeriod")}>
              <option value="1s">/s</option>
              <option value="1m">/min</option>
              <option value="1h">/hour</option>
            </select>
          </div>
        )}
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "4px 0 0" }}>{t("apps.rateLimitDesc")}</p>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </SectionCard>
  );
}

// Upload an operator-supplied TLS cert for this app's domain (certType "custom"). The cert is served
// statically by Traefik (no ACME) and applied on the next deploy. The private key never comes back from
// the server — the card only shows the covered domains + expiry once a cert is stored.
export function CustomCertCard({
  id,
  hasCustomCert,
  certDomains,
  certNotAfter,
}: {
  id: string;
  hasCustomCert: boolean;
  certDomains: string[];
  certNotAfter: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["app", id] });
  const upload = useMutation({
    mutationFn: () => api.setAppCert(id, cert, key),
    onSuccess: () => { setCert(""); setKey(""); invalidate(); },
    meta: { successMessage: t("apps.certUploaded") },
  });
  const clear = useMutation({
    mutationFn: () => api.clearAppCert(id),
    onSuccess: invalidate,
    meta: { successMessage: t("apps.certCleared") },
  });
  const ta: React.CSSProperties = { ...envField, width: "100%", minHeight: 88, fontFamily: "monospace", fontSize: 12, resize: "vertical" };

  return (
    <SectionCard title={t("apps.customCert")} desc={t("apps.customCertDesc")}>
      {hasCustomCert && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--c-tx2)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "2px 8px" }}>
            {certDomains.length ? certDomains.join(", ") : "—"}
          </span>
          {certNotAfter && (
            <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.certExpires", { date: new Date(certNotAfter).toLocaleDateString() })}</span>
          )}
          <Btn
            variant="dangerGhost"
            disabled={clear.isPending}
            onClick={async () => { if (await confirm({ body: t("apps.certClearConfirm"), danger: true })) clear.mutate(); }}
          >
            {t("apps.certRemove")}
          </Btn>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea style={ta} placeholder={t("apps.certPemPlaceholder")} value={cert} onChange={(e) => setCert(e.target.value)} aria-label={t("apps.certPem")} spellCheck={false} autoComplete="off" />
        <textarea style={ta} placeholder={t("apps.certKeyPlaceholder")} value={key} onChange={(e) => setKey(e.target.value)} aria-label={t("apps.certKey")} spellCheck={false} autoComplete="off" />
        <div>
          <Btn onClick={() => upload.mutate()} disabled={upload.isPending || !cert.trim() || !key.trim()}>
            {hasCustomCert ? t("apps.certReplace") : t("apps.certUpload")}
          </Btn>
        </div>
      </div>
      {upload.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{(upload.error as Error).message}</div>}
      {(upload.isSuccess || clear.isSuccess) && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </SectionCard>
  );
}
