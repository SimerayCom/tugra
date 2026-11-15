"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type CutoverEntryView, type CutoverServerView, type CutoverTtlGuidance, type CutoverView } from "../lib/api";
import { useT } from "../i18n/provider";
import {
  BLOCK_KEY, CERT_KEY, CUTOVER_POLL_MS, DNS_KEY, ROLE_KEY, WARN_KEY,
  canExclude, flippedSourceApps, fmtWhen, isExcluded, isFinalizable, isFlippable, isRevertible, isRunning, needsCounterpartFix, targetHostnames, tCode,
} from "../lib/cutover";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";
import { Badge, Btn, SectionCard, Spinner } from "./ui";
import { CutoverStateBadge } from "./cutover-state-badge";
import { CutoverFlipDialog } from "./cutover-flip-dialog";
import { CutoverRevertDialog } from "./cutover-revert-dialog";
import { CutoverTtlGuidance as TtlGuidance } from "./cutover-ttl-guidance";
import { CutoverSourceStop } from "./cutover-source-stop";

const BIND_KEY: Record<string, string> = {
  public: "cutover.preflight.bindPublic",
  loopback: "cutover.preflight.bindLoopback",
  none: "cutover.preflight.bindNone",
};
const COLS = ["cutover.col.host", "cutover.col.app", "cutover.col.role", "cutover.col.dns", "cutover.col.cert", "cutover.col.ttl", "cutover.col.precheck", "cutover.col.state", "cutover.col.actions"] as const;
const COVERAGE_KEY: Record<CutoverServerView["coverage"], string> = {
  verified: "cutover.preflight.coverageVerified",
  unverified: "cutover.preflight.coverageUnverified",
  none: "cutover.preflight.coverageNone",
};

/**
 * Move the DNS (and so the TLS endpoint) of imported apps from the source PaaS to Tugra, host by host: prepare
 * certificates, precheck, lower the TTL, then flip in rate-limited batches and verify. Cloudflare-managed hosts are
 * flipped by the hub; manual-DNS hosts get copy-paste records. The panel polls every 3 s while a flip run is active.
 */
export function CutoverPanel({ opId }: { opId: string }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const key = ["cutover", opId];

  const q = useQuery({
    queryKey: key,
    queryFn: () => api.getCutover(opId),
    retry: false,
    refetchInterval: (query) => (isRunning(query.state.data as CutoverView | undefined) ? CUTOVER_POLL_MS : false),
  });
  const { data: credentials = [] } = useQuery({ queryKey: ["dns-credentials"], queryFn: () => api.listDnsCredentials() });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [credId, setCredId] = useState("");
  const [challenge, setChallenge] = useState<"dns01" | "http01">("dns01");
  const [probeVia, setProbeVia] = useState<"hub" | "agent">("hub");
  const [healthPath, setHealthPath] = useState("");
  const [guidance, setGuidance] = useState<CutoverTtlGuidance[]>([]);
  const [blocked, setBlocked] = useState<Array<{ hostname: string; reason: string }>>([]);
  const [flipHosts, setFlipHosts] = useState<string[] | null>(null);
  const [revertHosts, setRevertHosts] = useState<string[] | null>(null);

  const setView = (view: CutoverView) => qc.setQueryData(key, view);
  const view = q.data;
  const entries = view?.entries ?? [];
  const running = isRunning(view);
  const notInitialised = q.error instanceof ApiError && q.error.status === 404;

  const init = useMutation({ mutationFn: () => api.cutoverInit(opId, credId ? { dnsCredentialId: credId } : {}), onSuccess: setView });
  const prepare = useMutation({
    mutationFn: (hostnames: string[]) => api.cutoverCertPrepare(opId, { hostnames, challenge }),
    onSuccess: (r, hostnames) => {
      setBlocked(r.blocked);
      setView(r.view);
      toast(t("cutover.done.prepare", { ready: Math.max(0, hostnames.length - r.blocked.length), blocked: r.blocked.length }), "success");
    },
  });
  const check = useMutation({
    mutationFn: (hostnames: string[]) => api.cutoverCheck(opId, { hostnames, probeVia, ...(healthPath.trim() ? { healthPath: healthPath.trim() } : {}) }),
    onSuccess: (v, hostnames) => {
      setView(v);
      const checked = v.entries.filter((e) => hostnames.includes(e.hostname));
      const blockedCount = checked.filter((e) => e.state === "BLOCKED" || e.state === "CONFLICT").length;
      toast(t("cutover.done.check", { ready: checked.filter((e) => e.state === "READY").length, blocked: blockedCount }), "success");
    },
  });
  const ttl = useMutation({
    mutationFn: (hostnames: string[]) => api.cutoverTtl(opId, { hostnames }),
    onSuccess: (r) => { setGuidance(r.guidance); setView(r.view); toast(t("cutover.done.ttl", { count: r.guidance.length }), "success"); },
  });
  const cancel = useMutation({ mutationFn: () => api.cutoverCancel(opId), onSuccess: setView });
  const finalize = useMutation({
    mutationFn: (hostnames: string[]) => api.cutoverFinalize(opId, { hostnames }),
    onSuccess: (v, hostnames) => { setView(v); toast(t("cutover.done.finalize", { count: hostnames.length }), "success"); },
  });
  const exclude = useMutation({ mutationFn: (v: { hostnames: string[]; excluded: boolean }) => api.cutoverExclude(opId, v), onSuccess: setView });
  const fix = useMutation({ mutationFn: (v: { applicationId: string; direction: "root" | "www" }) => api.cutoverFixCounterpart(opId, v), onSuccess: setView });
  const seed = useMutation({
    mutationFn: () => api.cutoverSeedCerts(opId, { acknowledgeProxyRestart: true }),
    onSuccess: (r) => { setView(r.view); toast(t("cutover.seed.done", { count: r.applied }), "success"); },
  });

  const busy = [init, prepare, check, ttl, cancel, finalize, exclude, fix, seed].some((m) => m.isPending);
  const toggle = (h: string) => setSelected((s) => { const n = new Set(s); if (n.has(h)) n.delete(h); else n.add(h); return n; });

  const flippable = targetHostnames(entries, selected, isFlippable);
  const revertible = targetHostnames(entries, selected, isRevertible);
  const finalizable = targetHostnames(entries, selected, isFinalizable);
  const all = targetHostnames(entries, selected);
  const excludable = targetHostnames(entries, selected, canExclude);
  const includable = targetHostnames(entries, selected, isExcluded);
  const stagedLeft = view ? Math.max(0, view.certs.staged - view.certs.applied) : 0;
  const deployNeeded = entries.filter((e) => e.needsDeploy);
  const stopItems = flippedSourceApps(entries);
  const statefulFlipped = entries.some((e) => e.stateful && e.flippedAt && stopItems.some((s) => s.applicationId === e.applicationId));

  const onSeed = async () => {
    const ok = await confirm({ title: t("cutover.seed.title"), body: t("cutover.seed.body"), confirmLabel: t("cutover.action.seedCerts") });
    if (ok) seed.mutate();
  };

  const header = (
    <SectionCard title={t("cutover.title")} desc={t("cutover.intro")} right={<Badge>{t("cutover.step.label")}</Badge>} style={{ padding: 20, marginTop: 16, marginBottom: 0 }}>
      {q.isLoading && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx3)" }}><Spinner /> {t("cutover.loading")}</div>}
      {q.isError && !notInitialised && (
        <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 10 }}>
          {(q.error as Error).message} <Btn variant="ghost" onClick={() => void q.refetch()}>{t("cutover.retry")}</Btn>
        </div>
      )}
      {(notInitialised || (view && entries.length === 0)) && (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 10px" }}>{notInitialised ? t("cutover.notInitialised") : t("cutover.noEntries")}</p>
      )}
      {(notInitialised || view) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--c-tx3)", minWidth: 200 }}>
            {t("cutover.init.credential")}
            <select value={credId} onChange={(e) => setCredId(e.target.value)} style={field}>
              <option value="">{t("cutover.init.credentialAuto")}</option>
              {credentials.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <Btn variant={view && entries.length > 0 ? "ghost" : "primary"} onClick={() => init.mutate()} disabled={busy} loading={init.isPending}>
            {view && entries.length > 0 ? t("cutover.action.rescan") : t("cutover.action.init")}
          </Btn>
        </div>
      )}
    </SectionCard>
  );

  if (!view || entries.length === 0) return header;

  return (
    <>
      {header}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
        {view.servers.length > 0 && (
          <SectionCard title={t("cutover.preflight.title")} style={{ padding: 16, marginBottom: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
              {view.servers.map((s) => <ServerStrip key={s.serverId} server={s} />)}
            </div>
          </SectionCard>
        )}

        <SectionCard
          title={t("cutover.entries.title")}
          desc={t("cutover.summary", { total: view.summary.total, ready: view.summary.ready, switched: view.summary.switched, verified: view.summary.verified, blocked: view.summary.blocked + view.summary.conflict })}
          right={running ? <Badge tone="warn">{t("cutover.run.running")}</Badge> : undefined}
          style={{ padding: 16, marginBottom: 0 }}
        >
          {view.run && (
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>
              {t("cutover.run.status", { status: view.run.status, done: view.run.batchesDone })}
              {view.run.lastError ? <span style={{ color: "var(--c-r)" }}> · {view.run.lastError}</span> : null}
            </div>
          )}

          {/* batch bar */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
            <div style={bar}>
              <Btn variant="ghost" onClick={() => setSelected(new Set(entries.map((e) => e.hostname)))}>{t("cutover.action.selectAll")}</Btn>
              <Btn variant="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>{t("cutover.action.selectNone")}</Btn>
              <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{selected.size > 0 ? t("cutover.selected", { count: selected.size }) : t("cutover.selectedNone")}</span>
            </div>
            <div style={bar}>
              <select aria-label={t("cutover.challenge.label")} value={challenge} onChange={(e) => setChallenge(e.target.value as "dns01" | "http01")} style={{ ...field, width: "auto" }}>
                <option value="dns01">{t("cutover.challenge.dns01")}</option>
                <option value="http01">{t("cutover.challenge.http01")}</option>
              </select>
              <Btn onClick={() => prepare.mutate(all)} loading={prepare.isPending} disabled={busy || running || all.length === 0}>{t("cutover.action.prepareCerts")}</Btn>
              <select aria-label={t("cutover.probe.label")} value={probeVia} onChange={(e) => setProbeVia(e.target.value as "hub" | "agent")} style={{ ...field, width: "auto" }}>
                <option value="hub">{t("cutover.probe.viaHub")}</option>
                <option value="agent">{t("cutover.probe.viaAgent")}</option>
              </select>
              <input aria-label={t("cutover.probe.healthPath")} placeholder={t("cutover.probe.healthPathPlaceholder")} value={healthPath} onChange={(e) => setHealthPath(e.target.value)} style={{ ...field, width: 150 }} spellCheck={false} autoComplete="off" />
              <Btn onClick={() => check.mutate(all)} loading={check.isPending} disabled={busy || all.length === 0}>{t("cutover.action.check")}</Btn>
              <Btn variant="ghost" onClick={() => ttl.mutate(all)} loading={ttl.isPending} disabled={busy || all.length === 0}>{t("cutover.action.lowerTtl")}</Btn>
            </div>
            {probeVia === "agent" && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: 0 }}>{t("cutover.probe.agentNote")}</p>}
            <div style={bar}>
              <Btn onClick={() => setFlipHosts(flippable)} disabled={busy || running || flippable.length === 0}>{t("cutover.action.planFlip")}</Btn>
              {running && <Btn variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>{t("cutover.action.cancel")}</Btn>}
              <Btn variant="ghost" onClick={() => finalize.mutate(finalizable)} loading={finalize.isPending} disabled={busy || running || finalizable.length === 0}>{t("cutover.action.finalize")}</Btn>
              <Btn variant="dangerGhost" onClick={() => setRevertHosts(revertible)} disabled={busy || running || revertible.length === 0}>{t("cutover.action.revert")}</Btn>
              <Btn variant="ghost" onClick={() => exclude.mutate({ hostnames: excludable, excluded: true })} disabled={busy || running || excludable.length === 0}>{t("cutover.action.exclude")}</Btn>
              <Btn variant="ghost" onClick={() => exclude.mutate({ hostnames: includable, excluded: false })} disabled={busy || running || includable.length === 0}>{t("cutover.action.include")}</Btn>
              {stagedLeft > 0 && <Btn variant="ghost" onClick={onSeed} disabled={busy || running}>{t("cutover.action.seedCerts")} ({stagedLeft})</Btn>}
            </div>
          </div>

          {blocked.length > 0 && (
            <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: "var(--c-am)" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{t("cutover.prepare.blocked", { count: blocked.length })}</div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>{blocked.map((b) => <li key={b.hostname}><span className="mono">{b.hostname}</span>: {tCode(t, BLOCK_KEY, b.reason)}</li>)}</ul>
            </div>
          )}

          {deployNeeded.length > 0 && (
            <p role="note" style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("cutover.deployNeeded", { count: deployNeeded.length })}</p>
          )}

          <div style={{ overflowX: "auto" }}>
            <table className="tg-cutover-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--c-tx3)" }}>
                  <th style={th}>
                    <input type="checkbox" aria-label={t("cutover.action.selectAll")} checked={selected.size === entries.length && entries.length > 0} onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.hostname)) : new Set())} />
                  </th>
                  {COLS.map((c) => <th key={c} style={th}>{t(c)}</th>)}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Row
                    key={e.id}
                    e={e}
                    checked={selected.has(e.hostname)}
                    onToggle={() => toggle(e.hostname)}
                    busy={busy || running}
                    onFix={(direction) => fix.mutate({ applicationId: e.applicationId, direction })}
                    onExclude={(excluded) => exclude.mutate({ hostnames: [e.hostname], excluded })}
                    onRevert={() => setRevertHosts([e.hostname])}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {guidance.length > 0 && <TtlGuidance guidance={guidance} />}
        {stopItems.length > 0 && <CutoverSourceStop items={stopItems.map((s) => ({ appName: s.appName, sourceName: s.sourceName, hostnames: s.hostnames }))} stateful={statefulFlipped} />}
      </div>

      {flipHosts && <CutoverFlipDialog opId={opId} hostnames={flipHosts} entries={entries} onClose={() => setFlipHosts(null)} />}
      {revertHosts && <CutoverRevertDialog opId={opId} hostnames={revertHosts} onClose={() => setRevertHosts(null)} />}
    </>
  );
}

function ServerStrip({ server: s }: { server: CutoverServerView }) {
  const t = useT();
  const rows: Array<[string, boolean, string]> = [
    [t("cutover.preflight.acmeEmail"), s.acmeEmailOk, s.acmeEmailOk ? t("cutover.preflight.ok") : t("cutover.preflight.missing")],
    [t("cutover.preflight.dnsReady"), s.dnsReady, s.dnsReady ? (s.dnsProvider ?? t("cutover.preflight.ok")) : t("cutover.preflight.missing")],
    [t("cutover.preflight.port80"), s.proxyBind === "public", tCode(t, BIND_KEY, s.proxyBind)],
    [t("cutover.preflight.publicIp"), !!s.publicIp, s.publicIp ?? t("cutover.preflight.missing")],
    [t("cutover.preflight.coverage"), s.coverage === "verified", t(COVERAGE_KEY[s.coverage])],
  ];
  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, wordBreak: "break-word" }}>{s.name}</div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        {rows.map(([label, ok, value]) => (
          <li key={label} style={{ display: "flex", gap: 8, fontSize: 12 }}>
            <span aria-hidden style={{ color: ok ? "var(--c-g)" : "var(--c-am)", fontWeight: 700 }}>{ok ? "✓" : "!"}</span>
            <span style={{ color: "var(--c-tx3)", flex: 1 }}>{label}</span>
            <span className="mono" style={{ color: ok ? "var(--c-tx2)" : "var(--c-am)", wordBreak: "break-all", textAlign: "right" }}>{value}</span>
          </li>
        ))}
      </ul>
      {s.dnsCredentialId && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "6px 0 0", lineHeight: 1.5 }}>{t("cutover.warn.tokenCopied")}</p>}
      {s.warnings.length > 0 && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--c-am)" }}>
          {s.warnings.map((w) => <li key={w}>{tCode(t, WARN_KEY, w)}</li>)}
        </ul>
      )}
    </div>
  );
}

function Row({ e, checked, onToggle, busy, onFix, onExclude, onRevert }: {
  e: CutoverEntryView; checked: boolean; onToggle: () => void; busy: boolean;
  onFix: (d: "root" | "www") => void; onExclude: (excluded: boolean) => void; onRevert: () => void;
}) {
  const t = useT();
  const dnsLabel = tCode(t, DNS_KEY, e.dnsObserved);
  const ttlText = e.currentTtl === null && e.targetTtl === null ? "—" : t("cutover.ttl.change", { current: e.currentTtl ?? "—", target: e.targetTtl ?? "—" });
  return (
    <tr style={{ borderTop: "1px solid var(--c-bd)", verticalAlign: "top", opacity: isExcluded(e) ? 0.65 : 1 }}>
      <td style={td}><input type="checkbox" checked={checked} onChange={onToggle} aria-label={t("cutover.selectRow", { host: e.hostname })} /></td>
      <td style={td} data-label={t("cutover.col.host")}>
        <div className="mono" style={{ fontWeight: 600, wordBreak: "break-all" }}>{e.hostname}</div>
        {e.blockReason && <div style={{ color: "var(--c-r)", fontSize: 11 }}>{tCode(t, BLOCK_KEY, e.blockReason)}</div>}
        {e.certError && <div style={{ color: "var(--c-r)", fontSize: 11, wordBreak: "break-word" }}>{e.certError}</div>}
        {e.lastError && <div style={{ color: "var(--c-r)", fontSize: 11, wordBreak: "break-word" }}>{e.lastError}</div>}
        {e.warnings.length > 0 && (
          <ul style={{ margin: "4px 0 0", paddingLeft: 14, fontSize: 11, color: "var(--c-am)" }}>
            {e.warnings.map((w) => <li key={w}>{tCode(t, WARN_KEY, w)}</li>)}
          </ul>
        )}
      </td>
      <td style={td} data-label={t("cutover.col.app")}>{e.appName}</td>
      <td style={td} data-label={t("cutover.col.role")}>{tCode(t, ROLE_KEY, e.role)}</td>
      <td style={td} data-label={t("cutover.col.dns")}>
        <span>{dnsLabel}</span>
        {e.proxied && e.dnsObserved !== "proxied" && <span style={{ color: "var(--c-tx3)" }}> · {t("cutover.dns.proxied")}</span>}
        {e.viaWildcard && <span style={{ color: "var(--c-tx3)" }}> · {t("cutover.dns.viaWildcard")}</span>}
      </td>
      <td style={td} data-label={t("cutover.col.cert")}>
        <div>{tCode(t, CERT_KEY, e.certState)}</div>
        {e.certIssuer && <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{e.certIssuer}</div>}
        {e.certNotAfter && <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("cutover.cert.expires", { date: fmtWhen(e.certNotAfter) })}</div>}
      </td>
      <td style={td} data-label={t("cutover.col.ttl")}>
        <div className="mono">{ttlText}</div>
        {e.ttlWaitUntil && <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("cutover.ttl.waitUntil", { when: fmtWhen(e.ttlWaitUntil) })}</div>}
      </td>
      <td style={td} data-label={t("cutover.col.precheck")}>{fmtWhen(e.precheckAt)}</td>
      <td style={td} data-label={t("cutover.col.state")}><CutoverStateBadge state={e.state} /></td>
      <td style={td} data-label={t("cutover.col.actions")}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {needsCounterpartFix(e) && (
            <>
              <Btn variant="ghost" onClick={() => onFix("root")} disabled={busy} aria-label={t("cutover.action.fixRootFor", { host: e.hostname })}>{t("cutover.action.fixRoot")}</Btn>
              <Btn variant="ghost" onClick={() => onFix("www")} disabled={busy} aria-label={t("cutover.action.fixWwwFor", { host: e.hostname })}>{t("cutover.action.fixWww")}</Btn>
            </>
          )}
          {e.needsDeploy && <Link href={`/apps/${e.applicationId}`} style={{ fontSize: 12, color: "var(--c-lapis)", alignSelf: "center" }}>{t("cutover.action.deploy")}</Link>}
          {isRevertible(e) && <Btn variant="dangerGhost" onClick={onRevert} disabled={busy}>{t("cutover.action.revert")}</Btn>}
          {isExcluded(e) ? (
            <Btn variant="ghost" onClick={() => onExclude(false)} disabled={busy}>{t("cutover.action.include")}</Btn>
          ) : canExclude(e) ? (
            <Btn variant="ghost" onClick={() => onExclude(true)} disabled={busy}>{t("cutover.action.exclude")}</Btn>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

const field: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontFamily: "inherit",
};
const bar: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px", color: "var(--c-tx2)" };
