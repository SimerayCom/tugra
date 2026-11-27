"use client";

import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Badge, Btn, SectionCard } from "./ui";
import { Field, fieldStyle } from "./form";
import { useToast } from "./toast";
import {
  buildApplyInput,
  connectErrorCode,
  summarizePreview,
  type BeszelAlertOutcome,
  type BeszelAlertRow,
  type BeszelAlertSkipReason,
  type BeszelApplyResult,
  type BeszelChannelOutcome,
  type BeszelChannelSkipReason,
  type BeszelMatchBy,
  type BeszelMetric,
  type BeszelPreview,
  type BeszelUnmatchedReason,
} from "../lib/beszel-import";

// Literal keys behind lookups, so the key-usage check can see every message the page can show.
const ERR = {
  badCredentials: "beszelImport.err.badCredentials",
  notBeszel: "beszelImport.err.notBeszel",
  unreachable: "beszelImport.err.unreachable",
  mfa: "beszelImport.err.mfa",
  forbidden: "beszelImport.err.forbidden",
  generic: "beszelImport.err.generic",
} as const;
const BY: Record<BeszelMatchBy, string> = { ip: "beszelImport.systems.by.ip", hostname: "beszelImport.systems.by.hostname", name: "beszelImport.systems.by.name", manual: "beszelImport.systems.by.manual" };
const UNMATCHED: Record<BeszelUnmatchedReason, string> = {
  none: "beszelImport.systems.unmatched.none",
  ambiguous: "beszelImport.systems.unmatched.ambiguous",
  duplicate: "beszelImport.systems.unmatched.duplicate",
  socket: "beszelImport.systems.unmatched.socket",
};
const METRIC: Record<BeszelMetric, string> = {
  CPU: "beszelImport.alerts.metric.CPU",
  MEM: "beszelImport.alerts.metric.MEM",
  DISK: "beszelImport.alerts.metric.DISK",
  LOAD1: "beszelImport.alerts.metric.LOAD1",
  LOAD5: "beszelImport.alerts.metric.LOAD5",
  LOAD15: "beszelImport.alerts.metric.LOAD15",
  TEMP: "beszelImport.alerts.metric.TEMP",
  NET: "beszelImport.alerts.metric.NET",
};
const ALERT_OUTCOME: Record<BeszelAlertOutcome, { key: string; tone: "ok" | "muted" | "warn" | "lapis" }> = {
  create: { key: "beszelImport.alerts.outcome.create", tone: "ok" },
  exists: { key: "beszelImport.alerts.outcome.exists", tone: "muted" },
  covered: { key: "beszelImport.alerts.outcome.covered", tone: "lapis" },
  skip: { key: "beszelImport.alerts.outcome.skip", tone: "muted" },
  noServer: { key: "beszelImport.alerts.outcome.noServer", tone: "warn" },
};
const ALERT_SKIP: Record<BeszelAlertSkipReason, string> = {
  battery: "beszelImport.alerts.skip.battery",
  gpu: "beszelImport.alerts.skip.gpu",
  cpuState: "beszelImport.alerts.skip.cpuState",
  container: "beszelImport.alerts.skip.container",
  systemd: "beszelImport.alerts.skip.systemd",
  network: "beszelImport.alerts.skip.network",
  smart: "beszelImport.alerts.skip.smart",
  other: "beszelImport.alerts.skip.other",
};
const CHANNEL_OUTCOME: Record<BeszelChannelOutcome, { key: string; tone: "ok" | "muted" }> = {
  create: { key: "beszelImport.channels.outcome.create", tone: "ok" },
  exists: { key: "beszelImport.channels.outcome.exists", tone: "muted" },
  skip: { key: "beszelImport.channels.outcome.skip", tone: "muted" },
};
const CHANNEL_SKIP: Record<BeszelChannelSkipReason, string> = {
  invalidUrl: "beszelImport.channels.skip.invalidUrl",
  unsupportedService: "beszelImport.channels.skip.unsupportedService",
  unsupportedAuth: "beszelImport.channels.skip.unsupportedAuth",
  unsupportedBot: "beszelImport.channels.skip.unsupportedBot",
  duplicate: "beszelImport.channels.skip.duplicate",
};
const CHANNEL_NOTE = { genericPayload: "beszelImport.channels.note.genericPayload", multipleChats: "beszelImport.channels.note.multipleChats" } as const;
const FAILURE = { rejected: "beszelImport.result.failure.rejected", error: "beszelImport.result.failure.error" } as const;

const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 0", borderTop: "1px solid var(--c-bd)", minHeight: 44 };
const hint: CSSProperties = { fontSize: 12, color: "var(--c-tx3)", margin: 0 };
const check: CSSProperties = { width: 20, height: 20, flexShrink: 0, accentColor: "var(--c-a)" };
/** A label wrapping a control gives the whole row a 44 px tap target. */
const tapLabel: CSSProperties = { display: "flex", alignItems: "center", gap: 10, minHeight: 44, cursor: "pointer", fontSize: 13, color: "var(--c-tx)" };

export function BeszelImport() {
  const t = useT();
  const toast = useToast();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  // Default: the team of the first server you can write to (else your first team); with several teams you can pick.
  const [pickedTeam, setPickedTeam] = useState("");
  const teamId = teams.some((x) => x.id === pickedTeam) ? pickedTeam : (servers.find((s) => s.canWrite)?.teamId ?? teams[0]?.id ?? "");

  const [baseUrl, setBaseUrl] = useState("");
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [keep, setKeep] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<BeszelPreview | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [parts, setParts] = useState({ alerts: true, channels: true, history: true });
  const [result, setResult] = useState<BeszelApplyResult | null>(null);
  const [kept, setKept] = useState(false);

  const { data: saved = [], refetch: refetchSaved } = useQuery({ queryKey: ["beszel-sessions"], queryFn: () => api.beszelSessions(), retry: false });
  const forgetSavedM = useMutation({
    mutationFn: (sid: string) => api.beszelDisconnect(sid),
    onSuccess: (_r, sid) => { void refetchSaved(); toast(t("beszelImport.saved.forgotten", { host: saved.find((c) => c.sessionId === sid)?.host ?? "" }), "success"); },
    onError: (e) => toast((e as Error).message, "error"),
  });

  const previewM = useMutation({
    mutationFn: (v: { sid: string; overrides: Record<string, string | null> }) => api.beszelPreview({ sessionId: v.sid, ...(Object.keys(v.overrides).length ? { serverOverrides: v.overrides } : {}) }),
    onSuccess: (p) => {
      setPreview(p);
      setParts((cur) => ({ ...cur, history: cur.history && p.history.totalPoints > 0 }));
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  /** Pick up a connection the operator chose to keep: straight to the preview, no sign-in. */
  const reuse = (sid: string) => {
    setSessionId(sid);
    setKept(true);
    previewM.mutate({ sid, overrides: {} });
  };
  const connectM = useMutation({
    mutationFn: () => api.beszelConnect({ teamId, baseUrl: baseUrl.trim(), identity: identity.trim(), password, keepCredentials: keep }),
    onSuccess: (s) => {
      setPassword(""); // the form never holds it longer than the call
      setSessionId(s.sessionId);
      setKept(s.credentialsKept);
      previewM.mutate({ sid: s.sessionId, overrides: {} });
    },
  });
  const applyM = useMutation({
    mutationFn: () => api.beszelApply(buildApplyInput(preview!, { overrides, parts, excluded })),
    onSuccess: setResult,
    onError: (e) => toast((e as Error).message, "error"),
  });
  const forgetM = useMutation({
    mutationFn: () => api.beszelDisconnect(sessionId!),
    onSuccess: () => {
      setKept(false);
      setSessionId(null);
    },
    onError: (e) => toast((e as Error).message, "error"),
  });

  const reset = () => {
    setSessionId(null);
    setPreview(null);
    setResult(null);
    setOverrides({});
    setExcluded(new Set());
    setPassword("");
    connectM.reset();
    previewM.reset();
    applyM.reset();
  };

  const pickServer = (systemId: string, serverId: string) => {
    const next = { ...overrides, [systemId]: serverId === "" ? null : serverId };
    setOverrides(next);
    if (sessionId) previewM.mutate({ sid: sessionId, overrides: next });
  };
  const toggleSystem = (id: string) =>
    setExcluded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (result) {
    return (
      <ResultCard
        result={result}
        kept={kept && !result.credentialsDropped}
        forgetting={forgetM.isPending}
        onForget={() => forgetM.mutate()}
        onReset={reset}
      />
    );
  }

  if (!preview || !sessionId) {
    const busy = connectM.isPending || previewM.isPending;
    const err = connectM.isError ? connectErrorCode(connectM.error) : null;
    return (
      <>
      {saved.length > 0 && (
        <SectionCard title={t("beszelImport.saved.title")} desc={t("beszelImport.saved.desc")} style={{ maxWidth: 560 }}>
          {saved.map((c) => (
            <div key={c.sessionId} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <Btn loading={busy} disabled={forgetSavedM.isPending && forgetSavedM.variables === c.sessionId} onClick={() => reuse(c.sessionId)}>{t("beszelImport.saved.use", { host: c.host })}</Btn>
              <Btn variant="ghost" loading={forgetSavedM.isPending && forgetSavedM.variables === c.sessionId} disabled={busy} onClick={() => forgetSavedM.mutate(c.sessionId)}>{t("beszelImport.saved.forget", { host: c.host })}</Btn>
            </div>
          ))}
        </SectionCard>
      )}
      <SectionCard title={t("beszelImport.connect.title")} desc={t("beszelImport.connect.desc")} style={{ maxWidth: 560 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            connectM.mutate();
          }}
        >
          {teams.length > 1 && (
            <>
              <Field label={t("beszelImport.connect.team")} htmlFor="bz-team">
                <select id="bz-team" style={{ ...fieldStyle, minHeight: 44 }} value={teamId} onChange={(e) => setPickedTeam(e.target.value)}>
                  {teams.map((x) => (
                    <option key={x.id} value={x.id}>{x.name}</option>
                  ))}
                </select>
              </Field>
              <div style={{ height: 12 }} />
            </>
          )}
          <Field label={t("beszelImport.connect.url")} htmlFor="bz-url">
            <input id="bz-url" style={fieldStyle} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("beszelImport.connect.urlPlaceholder")} inputMode="url" autoComplete="off" spellCheck={false} required />
          </Field>
          <div style={{ height: 12 }} />
          <Field label={t("beszelImport.connect.identity")} htmlFor="bz-identity">
            <input id="bz-identity" style={fieldStyle} value={identity} onChange={(e) => setIdentity(e.target.value)} autoComplete="off" spellCheck={false} required />
          </Field>
          <div style={{ height: 12 }} />
          <Field label={t("beszelImport.connect.password")} htmlFor="bz-password">
            <input id="bz-password" style={fieldStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
          </Field>
          <label style={{ ...tapLabel, marginTop: 8 }}>
            <input type="checkbox" style={check} checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <span>{t("beszelImport.connect.keep")}</span>
          </label>
          <p style={{ ...hint, margin: "0 0 14px" }}>{t("beszelImport.connect.keepHelp")}</p>
          {err && (
            <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 10, overflowWrap: "anywhere" }}>
              {t(ERR[err])}
            </div>
          )}
          <Btn type="submit" loading={busy} disabled={!teamId || !baseUrl.trim() || !identity.trim() || !password}>
            {busy ? t("beszelImport.connect.submitting") : t("beszelImport.connect.submit")}
          </Btn>
        </form>
      </SectionCard>
      </>
    );
  }

  const sum = summarizePreview(preview, excluded);
  const refreshing = previewM.isPending;
  const noneSelected = !parts.alerts && !parts.channels && !parts.history;
  return (
    <div aria-busy={refreshing || undefined}>
      <SectionCard title={t("beszelImport.review.title")} desc={t("beszelImport.review.desc")} right={refreshing ? <span style={hint} role="status">{t("beszelImport.review.refreshing")}</span> : undefined}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Badge tone="lapis">{t("beszelImport.review.chipSystems", { n: sum.systemsMatched })}</Badge>
          <Badge tone="ok">{t("beszelImport.review.chipAlerts", { n: sum.alertsToCreate })}</Badge>
          <Badge tone="ok">{t("beszelImport.review.chipChannels", { n: sum.channelsToCreate })}</Badge>
          <Badge tone="muted">{t("beszelImport.review.chipHistory", { n: sum.historyPoints })}</Badge>
        </div>
      </SectionCard>

      <SectionCard title={t("beszelImport.systems.title")} desc={t("beszelImport.systems.desc")}>
        {preview.systems.map((s) => (
          <div key={s.id} style={row}>
            {s.match ? (
              <label style={{ ...tapLabel, flex: "1 1 220px" }}>
                <input type="checkbox" style={check} checked={!excluded.has(s.id)} onChange={() => toggleSystem(s.id)} aria-label={t("beszelImport.systems.include", { name: s.name })} />
                <span style={{ minWidth: 0 }}>
                  <strong style={{ fontWeight: 600 }}>{s.name}</strong>
                  <span className="mono" style={{ ...hint, display: "block", overflowWrap: "anywhere" }}>{s.host}</span>
                </span>
              </label>
            ) : (
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <strong style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</strong>
                <span className="mono" style={{ ...hint, display: "block", overflowWrap: "anywhere" }}>{s.host}</span>
              </div>
            )}
            <div style={{ flex: "1 1 220px", display: "flex", flexDirection: "column", gap: 4 }}>
              {s.match ? (
                <span style={{ fontSize: 13 }}>
                  {t("beszelImport.systems.matchedTo", { server: s.match.serverName })} <Badge tone="muted">{t(BY[s.match.by])}</Badge>
                </span>
              ) : (
                <span style={hint}>{t(UNMATCHED[s.unmatchedReason ?? "none"])}</span>
              )}
              {(!s.match || s.match.by === "manual") && preview.servers.length > 0 && (
                <select
                  aria-label={t("beszelImport.systems.pickLabel", { name: s.name })}
                  value={overrides[s.id] ?? ""}
                  disabled={refreshing}
                  onChange={(e) => pickServer(s.id, e.target.value)}
                  style={{ ...fieldStyle, minHeight: 44 }}
                >
                  <option value="">{s.match ? t("beszelImport.systems.leaveOut") : t("beszelImport.systems.pick")}</option>
                  {preview.servers.map((srv) => (
                    <option key={srv.id} value={srv.id}>{srv.name}</option>
                  ))}
                </select>
              )}
              {!s.match && preview.servers.length === 0 && <span style={hint}>{t("beszelImport.systems.noServers")}</span>}
            </div>
          </div>
        ))}
      </SectionCard>

      <SectionCard title={t("beszelImport.alerts.title")} desc={t("beszelImport.alerts.desc")}>
        <label style={tapLabel}>
          <input type="checkbox" style={check} checked={parts.alerts} onChange={(e) => setParts({ ...parts, alerts: e.target.checked })} />
          <span>{t("beszelImport.parts.alerts")}</span>
        </label>
        {preview.alerts.length === 0 ? (
          <p style={hint}>{t("beszelImport.alerts.none")}</p>
        ) : (
          <details>
            <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", fontSize: 12, color: "var(--c-tx3)" }}>{t("beszelImport.alerts.more")}</summary>
            <p style={{ ...hint, marginBottom: 6 }}>{t("beszelImport.alerts.approx")}</p>
            {preview.alerts.map((a) => (
              <AlertLine key={a.id} a={a} />
            ))}
          </details>
        )}
      </SectionCard>

      <SectionCard title={t("beszelImport.channels.title")} desc={t("beszelImport.channels.desc")}>
        <label style={tapLabel}>
          <input type="checkbox" style={check} checked={parts.channels} onChange={(e) => setParts({ ...parts, channels: e.target.checked })} />
          <span>{t("beszelImport.parts.channels")}</span>
        </label>
        {preview.channels.length === 0 ? (
          <p style={hint}>{t("beszelImport.channels.none")}</p>
        ) : (
          <details>
            <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", fontSize: 12, color: "var(--c-tx3)" }}>{t("beszelImport.alerts.more")}</summary>
            {preview.channels.map((c) => (
              <div key={c.index} style={row}>
                <span style={{ flex: "1 1 200px", fontSize: 13, overflowWrap: "anywhere" }}>
                  <strong style={{ fontWeight: 600 }}>{c.service}</strong> <span className="mono" style={hint}>{c.label}</span>
                </span>
                <Badge tone={CHANNEL_OUTCOME[c.outcome].tone}>{t(CHANNEL_OUTCOME[c.outcome].key)}</Badge>
                {c.reason && <span style={{ ...hint, flexBasis: "100%" }}>{t(CHANNEL_SKIP[c.reason])}</span>}
                {c.notes.map((n) => (
                  <span key={n} style={{ ...hint, flexBasis: "100%" }}>{t(CHANNEL_NOTE[n])}</span>
                ))}
              </div>
            ))}
          </details>
        )}
        {preview.emails > 0 && <p style={{ ...hint, marginTop: 8 }}>{t("beszelImport.channels.emails", { n: preview.emails })}</p>}
      </SectionCard>

      <SectionCard title={t("beszelImport.history.title")} desc={t("beszelImport.history.desc", { days: preview.history.windowDays })}>
        <label style={tapLabel}>
          <input type="checkbox" style={check} checked={parts.history} disabled={sum.historyPoints === 0} onChange={(e) => setParts({ ...parts, history: e.target.checked })} />
          <span>{t("beszelImport.parts.history")}</span>
        </label>
        <p style={hint}>
          {sum.historyPoints > 0
            ? t("beszelImport.history.line", { points: sum.historyPoints, servers: preview.history.systems.filter((h) => h.points > 0).length })
            : t("beszelImport.history.none")}
        </p>
        <details>
          <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", fontSize: 12, color: "var(--c-tx3)" }}>{t("beszelImport.alerts.more")}</summary>
          <p style={hint}>{t("beszelImport.history.note")}</p>
        </details>
      </SectionCard>

      {applyM.isError && (applyM.error as { status?: number }).status === 409 && (
        <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 10 }}>{t("beszelImport.apply.stale")}</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Btn loading={applyM.isPending} disabled={noneSelected || refreshing} onClick={() => applyM.mutate()}>
          {applyM.isPending ? t("beszelImport.apply.applying") : t("beszelImport.apply.button")}
        </Btn>
        {applyM.isError && (applyM.error as { status?: number }).status === 409 && (
          <Btn variant="ghost" loading={refreshing} onClick={() => { applyM.reset(); previewM.mutate({ sid: sessionId, overrides }); }}>{t("beszelImport.apply.refresh")}</Btn>
        )}
        <Btn variant="ghost" onClick={reset}>{t("beszelImport.result.again")}</Btn>
        {noneSelected && <span style={hint}>{t("beszelImport.apply.nothing")}</span>}
      </div>
    </div>
  );
}

function AlertLine({ a }: { a: BeszelAlertRow }) {
  const t = useT();
  const o = ALERT_OUTCOME[a.outcome];
  const text = a.metric ? t("beszelImport.alerts.line", { metric: t(METRIC[a.metric]), limit: a.limit ?? 0, unit: a.unit ? (a.unit === "%" ? "%" : ` ${a.unit}`) : "", minutes: a.minutes }) : t("beszelImport.alerts.lineNoLimit", { name: a.name });
  return (
    <div style={row}>
      <span style={{ flex: "1 1 220px", fontSize: 13 }}>
        <strong style={{ fontWeight: 600 }}>{a.systemName}</strong> · {text}
      </span>
      <Badge tone={o.tone}>{t(o.key)}</Badge>
      {a.outcome === "covered" && <span style={{ ...hint, flexBasis: "100%" }}>{t("beszelImport.alerts.coveredHelp")}</span>}
      {a.outcome === "skip" && a.reason && <span style={{ ...hint, flexBasis: "100%" }}>{t(ALERT_SKIP[a.reason])}</span>}
    </div>
  );
}

function ResultCard({ result, kept, forgetting, onForget, onReset }: { result: BeszelApplyResult; kept: boolean; forgetting: boolean; onForget: () => void; onReset: () => void }) {
  const t = useT();
  const failed = result.failures.length;
  return (
    <SectionCard title={t("beszelImport.result.title")} style={{ maxWidth: 640 }}>
      <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
        <li>{t("beszelImport.result.monitors", { created: result.monitors.created, existing: result.monitors.existing, covered: result.monitors.covered })}</li>
        <li>{t("beszelImport.result.channels", { created: result.channels.created, existing: result.channels.existing })}</li>
        {result.history.points > 0 && <li>{t("beszelImport.result.history", { points: result.history.points, systems: result.history.systems })}</li>}
      </ul>
      {failed > 0 && (
        <div role="alert" style={{ marginBottom: 12 }}>
          <div style={{ color: "var(--c-r)", fontSize: 13 }}>{t("beszelImport.result.failed", { n: failed })}</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {[...new Set(result.failures.map((f) => f.reason))].map((r) => (
              <li key={r} style={hint}>{t(FAILURE[r])}</li>
            ))}
          </ul>
        </div>
      )}
      <p style={{ ...hint, marginBottom: 12 }}>{kept ? t("beszelImport.result.kept") : t("beszelImport.result.dropped")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Link href="/monitors" className="tg-btn" style={linkBtn}>{t("beszelImport.result.monitorsLink")}</Link>
        <Link href="/notifications" className="tg-btn" style={linkBtn}>{t("beszelImport.result.channelsLink")}</Link>
        {kept && <Btn variant="ghost" loading={forgetting} onClick={onForget}>{t("beszelImport.result.forget")}</Btn>}
        <Btn variant="ghost" onClick={onReset}>{t("beszelImport.result.again")}</Btn>
      </div>
    </SectionCard>
  );
}

const linkBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: "0 14px",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  color: "var(--c-tx)",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
};
