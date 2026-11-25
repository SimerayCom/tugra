"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../i18n/provider";
import type { Pm2MoveChoice, Pm2MoveJob, Pm2MoveJobItem, Pm2MovePlan } from "../lib/types";
import { Badge, Btn } from "./ui";
import { fieldStyle } from "./form";

const NODE_CHOICES = [12, 14, 16, 18, 20, 22, 24];
/** The same rule the hub applies to a health-check path (empty = no check). */
const PROBE_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,200}$/;
export const isValidProbePath = (v: string): boolean => v === "" || PROBE_PATH_RE.test(v);
type StartItem = Pm2MoveChoice & { planHash: string };

const rowStyle: CSSProperties = { display: "grid", gap: 6, padding: "10px 0", borderTop: "1px solid var(--c-bd)", fontSize: 13 };
const lineStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "4px 10px", flexWrap: "wrap", minWidth: 0 };
const dim: CSSProperties = { color: "var(--c-tx3)", fontSize: 12, minWidth: 0, overflowWrap: "anywhere" };
const note = (color = "var(--c-tx3)"): CSSProperties => ({ margin: "8px 0 0", fontSize: 12.5, color });

/** Map a failed call to its i18n key suffix. */
export function pm2MoveErrorKey(e: unknown): "errOwner" | "errForbidden" | "errOutdated" | "errUnavailable" | "errTooLarge" | "errBusy" | "errGeneric" {
  if (e instanceof ApiError) {
    if (e.status === 409) return "errBusy";
    if (e.status === 403) return /owner/i.test(e.message) ? "errOwner" : "errForbidden";
    if (e.status === 503) {
      if (/too large/i.test(e.message)) return "errTooLarge";
      return /agent/i.test(e.message) && /update/i.test(e.message) ? "errOutdated" : "errUnavailable";
    }
  }
  return "errGeneric";
}

function statusTone(s: Pm2MovePlan["status"]): "ok" | "warn" | "muted" {
  return s === "ready" ? "ok" : s === "needs-node" ? "warn" : "muted";
}
function itemTone(s: Pm2MoveJobItem["status"]): "ok" | "warn" | "danger" | "muted" {
  if (s === "moved") return "ok";
  if (s === "queued" || s === "running") return "muted";
  if (s === "rolled_back" || s === "aborted" || s === "plan_changed" || s === "failed") return "warn";
  return "danger";
}

/**
 * "Move to Tugra (in place)" for the PM2 processes of a scanned server. Instance-owner only (the hub enforces it; the UI
 * only hides what would be refused). Three steps in one place: a read-only preview per process, a confirmation that spells
 * out what will happen (and the rollback), then live progress of the one-after-the-other cutover.
 */
export function Pm2MovePanel({ serverId, online, canOps }: { serverId: string; online: boolean; canOps: boolean }) {
  const t = useT();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Record<string, { nodeMajor?: number; probePath?: string }>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const toInput = (c: typeof choices): Pm2MoveChoice[] =>
    Object.entries(c).map(([key, v]) => {
      const [u, ...rest] = key.split("/");
      return { user: u, name: rest.join("/"), nodeMajor: v.nodeMajor, probePath: v.probePath && isValidProbePath(v.probePath) ? v.probePath : null };
    });

  const plan = useMutation({ mutationFn: (c: typeof choices) => api.planPm2Move(serverId, toInput(c)) });
  const start = useMutation({
    mutationFn: (items: StartItem[]) => api.startPm2Move(serverId, { items }),
    onSuccess: (job) => {
      setJobId(job.id);
      setConfirming(false);
    },
  });
  const job = useQuery({
    queryKey: ["pm2-move-job", serverId, jobId],
    queryFn: () => api.getPm2MoveJob(serverId, jobId as string),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.state === "done" ? false : 2000),
  });

  if (!user?.isInstanceOwner) return null;
  const plans = plan.data?.plans ?? [];
  const movable = plans.filter((p) => p.status === "ready");
  const picked = plans.filter((p) => selected.has(p.key) && p.status === "ready");
  const running = !!jobId && job.data?.state !== "done";
  const disabledReason = !canOps ? t("servers.serverScan.needsOps") : !online ? t("servers.serverScan.offline") : undefined;

  const prepare = (next = choices) => {
    plan.mutate(next, {
      onSuccess: (r) => setSelected((cur) => new Set([...cur].filter((k) => r.plans.some((p) => p.key === k && p.status === "ready")))),
    });
  };
  const choose = (key: string, patch: { nodeMajor?: number; probePath?: string }) => {
    const next = { ...choices, [key]: { ...choices[key], ...patch } };
    setChoices(next);
    prepare(next);
  };
  const toggle = (key: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const go = (keys: string[]) => {
    setSelected(new Set(keys));
    setConfirming(true);
  };
  const reset = () => {
    setJobId(null);
    setConfirming(false);
    setSelected(new Set());
    qc.removeQueries({ queryKey: ["pm2-move-job", serverId] });
    prepare();
  };

  if (!open) {
    return (
      <div style={{ marginTop: 8 }}>
        <Btn
          variant="primary"
          disabled={!canOps || !online}
          title={disabledReason}
          onClick={() => {
            setOpen(true);
            prepare();
          }}
        >
          {t("servers.pm2Move.open")}
        </Btn>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", background: "var(--c-bg)" }} aria-label={t("servers.pm2Move.title")}>
      <div style={{ ...lineStyle, justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>{t("servers.pm2Move.title")}</strong>
        <span style={lineStyle}>
          {!running && !confirming && !jobId && (
            <Btn variant="ghost" loading={plan.isPending} onClick={() => prepare()}>
              {t("servers.pm2Move.refresh")}
            </Btn>
          )}
          {!running && (
            <Btn
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setJobId(null);
                setConfirming(false);
              }}
            >
              {t("servers.pm2Move.close")}
            </Btn>
          )}
        </span>
      </div>
      <p style={note()}>{t("servers.pm2Move.intro")}</p>
      <p style={note()}>{t("servers.pm2Move.envNote")}</p>
      {plan.isError && <p role="alert" style={note("var(--c-r)")}>{t(`servers.pm2Move.${pm2MoveErrorKey(plan.error)}`)}</p>}
      {start.isError && <p role="alert" style={note("var(--c-r)")}>{t(`servers.pm2Move.${pm2MoveErrorKey(start.error)}`)}</p>}

      {jobId ? (
        <JobView job={job.data} onAgain={reset} />
      ) : confirming ? (
        <Confirm plans={picked} busy={start.isPending} onBack={() => setConfirming(false)} onGo={() => start.mutate(picked.map((p): StartItem => ({ user: p.user, name: p.name, planHash: p.planHash, nodeMajor: choices[p.key]?.nodeMajor, probePath: choices[p.key]?.probePath || null })))} />
      ) : (
        <>
          {plan.isPending && !plan.data && <p style={note()}>{t("servers.pm2Move.preparing")}</p>}
          {plan.data?.truncated && <p style={note("var(--c-am)")}>{t("servers.pm2Move.truncated")}</p>}
          {plan.data && plans.length === 0 && <p style={note()}>{t("servers.pm2Move.empty")}</p>}
          {plans.length > 0 && (
            <div style={{ ...lineStyle, margin: "10px 0 2px" }}>
              <Btn variant="ghost" onClick={() => setSelected(new Set(movable.map((p) => p.key)))} disabled={movable.length === 0}>
                {t("servers.pm2Move.selectReady")}
              </Btn>
              {selected.size > 0 && (
                <Btn variant="ghost" onClick={() => setSelected(new Set())}>
                  {t("servers.pm2Move.selectNone")}
                </Btn>
              )}
              <Btn variant="primary" disabled={picked.length === 0} onClick={() => go(picked.map((p) => p.key))}>
                {t("servers.pm2Move.moveSelected", { n: picked.length })}
              </Btn>
            </div>
          )}
          {plans.map((p) => (
            <PlanRow
              key={p.key}
              p={p}
              checked={selected.has(p.key)}
              choice={choices[p.key]}
              onToggle={() => toggle(p.key)}
              onNode={(n) => choose(p.key, { nodeMajor: n })}
              onProbe={(v) => choose(p.key, { probePath: v })}
              onMove={() => go([p.key])}
            />
          ))}
        </>
      )}
    </div>
  );
}

function PlanRow({
  p,
  checked,
  choice,
  onToggle,
  onNode,
  onProbe,
  onMove,
}: {
  p: Pm2MovePlan;
  checked: boolean;
  choice?: { nodeMajor?: number; probePath?: string };
  onToggle: () => void;
  onNode: (n: number) => void;
  onProbe: (v: string) => void;
  onMove: () => void;
}) {
  const t = useT();
  const [probe, setProbe] = useState(choice?.probePath ?? p.probePath ?? "");
  const probeBad = !isValidProbePath(probe);
  const guessed = p.warnings.includes("node-guessed") && p.nodeMajor !== null;
  const supported = p.status !== "unsupported";
  const nodeOptions = [...new Set([...NODE_CHOICES, ...(p.nodeMajor ? [p.nodeMajor] : [])])].sort((a, b) => a - b);
  return (
    <div style={rowStyle}>
      <div style={lineStyle}>
        <input
          type="checkbox"
          checked={checked}
          disabled={p.status !== "ready"}
          onChange={onToggle}
          aria-label={p.name}
          style={{ accentColor: "var(--c-a)", flexShrink: 0, width: 18, height: 18 }}
        />
        <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{p.name}</span>
        <span style={dim}>{p.user}</span>
        <Badge tone={statusTone(p.status)}>{t(`servers.pm2Move.status.${p.status}`)}</Badge>
        {p.status === "ready" && (
          <Btn variant="ghost" onClick={onMove} disabled={probeBad}>
            {t("servers.pm2Move.moveOne")}
          </Btn>
        )}
      </div>
      {p.reasons.map((r) => (
        <div key={r} style={{ ...dim, color: "var(--c-tx2)" }}>
          {t(`servers.pm2Move.reason.${r}`, { interpreter: p.interpreter ?? "" })}
        </div>
      ))}
      {supported && (
        <>
          <div style={lineStyle}>
            <label style={{ ...dim, display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("servers.pm2Move.node")}
              <select
                value={p.nodeMajor ?? ""}
                onChange={(e) => e.target.value && onNode(Number(e.target.value))}
                style={{ ...fieldStyle, width: "auto", minHeight: 36 }}
                aria-label={`${t("servers.pm2Move.node")} ${p.name}`}
              >
                {p.nodeMajor === null && <option value="">{t("servers.pm2Move.nodeChoose")}</option>}
                {nodeOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {p.nodeSource !== "none" && <span style={dim}>{t(`servers.pm2Move.nodeSource.${p.nodeSource}`)}</span>}
            {guessed && (
              <Btn variant="ghost" onClick={() => onNode(p.nodeMajor as number)}>
                {t("servers.pm2Move.nodeConfirm", { n: p.nodeMajor as number })}
              </Btn>
            )}
          </div>
          {p.status === "ready" && (
            <>
              <div style={dim}>
                <span>{t("servers.pm2Move.field.folder")}: </span>
                <span className="mono">{p.mountDir}</span>
                {" · "}
                <span>{t("servers.pm2Move.field.user")}: </span>
                <span className="mono">
                  {p.uid}:{p.gid}
                </span>
                {p.groups.length > 0 && (
                  <>
                    {" · "}
                    <span>{t("servers.pm2Move.field.groups")}: </span>
                    <span className="mono">{p.groups.join(", ")}</span>
                  </>
                )}
                {p.port ? (
                  <>
                    {" · "}
                    <span>{t("servers.pm2Move.field.port")}: </span>
                    <span className="mono">{p.port}</span>
                  </>
                ) : null}
              </div>
              {p.domains.length > 0 && (
                <div style={dim}>
                  {t("servers.pm2Move.field.domains")}: {p.domains.join(", ")}
                </div>
              )}
              <div style={dim}>
                {t("servers.pm2Move.field.command")}: <span className="mono">{p.command.join(" ")}</span>
              </div>
              <div style={dim}>{t("servers.pm2Move.field.env", { n: p.envCount })}</div>
              {p.port !== null && (
                <label style={{ ...dim, display: "grid", gap: 4 }}>
                  {t("servers.pm2Move.probe")}
                  <input
                    value={probe}
                    onChange={(e) => setProbe(e.target.value.trim())}
                    // An invalid path is never sent: one bad value must not turn the whole preview into an error.
                    onBlur={() => !probeBad && probe !== (choice?.probePath ?? p.probePath ?? "") && onProbe(probe)}
                    placeholder="/health"
                    spellCheck={false}
                    aria-invalid={probeBad}
                    style={{ ...fieldStyle, maxWidth: 320, ...(probeBad ? { borderColor: "var(--c-r)" } : {}) }}
                    aria-label={`${t("servers.pm2Move.probe")} ${p.name}`}
                  />
                  {probeBad && (
                    <span role="alert" style={{ color: "var(--c-r)" }}>
                      {t("servers.pm2Move.probeInvalid")}
                    </span>
                  )}
                </label>
              )}
            </>
          )}
        </>
      )}
      {p.warnings.map((w) => (
        <div key={w} style={{ ...dim, color: "var(--c-am)" }}>
          {t(`servers.pm2Move.warning.${w}`, { n: p.sharedEnvCount })}
        </div>
      ))}
    </div>
  );
}

function Confirm({ plans, busy, onBack, onGo }: { plans: Pm2MovePlan[]; busy: boolean; onBack: () => void; onGo: () => void }) {
  const t = useT();
  return (
    <div role="group" aria-label={t("servers.pm2Move.confirm.title")} style={{ marginTop: 10 }}>
      <h4 style={{ margin: "0 0 4px", fontSize: 13 }}>{t("servers.pm2Move.confirm.title")}</h4>
      <p style={note()}>{t("servers.pm2Move.confirm.intro")}</p>
      <ol style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 13, display: "grid", gap: 4 }}>
        {(["s1", "s2", "s3", "s4", "s5", "s6", "s7"] as const).map((k) => (
          <li key={k}>{t(`servers.pm2Move.confirm.${k}`)}</li>
        ))}
      </ol>
      <p style={note("var(--c-am)")}>{t("servers.pm2Move.confirm.privilege")}</p>
      <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 4, fontSize: 13 }}>
        {plans.map((p) => (
          <li key={p.key} style={lineStyle}>
            <strong style={{ overflowWrap: "anywhere" }}>{p.name}</strong>
            <span className="mono" style={dim}>
              {p.image}
              {p.port ? ` · :${p.port}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <div style={{ ...lineStyle, marginTop: 12 }}>
        <Btn variant="primary" loading={busy} onClick={onGo}>
          {t("servers.pm2Move.confirm.go")}
        </Btn>
        <Btn variant="ghost" onClick={onBack} disabled={busy}>
          {t("servers.pm2Move.confirm.back")}
        </Btn>
      </div>
    </div>
  );
}

function codeText(t: ReturnType<typeof useT>, code: string | null): string {
  if (!code || code === "ok") return "";
  const key = `servers.pm2Move.code.${code}`;
  const txt = t(key);
  return txt === key ? t("servers.pm2Move.code.other") : txt;
}

function JobView({ job, onAgain }: { job: Pm2MoveJob | undefined; onAgain: () => void }) {
  const t = useT();
  if (!job) return <p style={note()}>{t("servers.pm2Move.preparing")}</p>;
  return (
    <div style={{ marginTop: 10 }} aria-live="polite">
      <h4 style={{ margin: "0 0 4px", fontSize: 13 }}>{job.state === "done" ? t("servers.pm2Move.job.doneTitle") : t("servers.pm2Move.job.title")}</h4>
      {job.items.map((i) => (
        <div key={i.key} style={rowStyle}>
          <div style={lineStyle}>
            <strong style={{ overflowWrap: "anywhere" }}>{i.name}</strong>
            <Badge tone={itemTone(i.status)}>{t(`servers.pm2Move.job.status.${i.status}`)}</Badge>
            {i.status === "running" && i.step && <span style={dim}>{stepText(t, i.step)}</span>}
            {i.status === "moved" && i.appId && (
              <Link href={`/apps/${i.appId}`} className="tg-link" style={{ fontSize: 12 }}>
                {t("servers.pm2Move.job.openApp")}
              </Link>
            )}
          </div>
          {i.status !== "moved" && i.status !== "queued" && i.status !== "running" && codeText(t, i.reason) && <div style={{ ...dim, color: "var(--c-tx2)" }}>{codeText(t, i.reason)}</div>}
          {i.pm2Left && (
            <div role="alert" style={{ ...dim, color: "var(--c-am)" }}>
              {t("servers.pm2Move.job.pm2Left")}
            </div>
          )}
          {(i.logTail.length > 0 || i.errTail.length > 0) && (
            <details style={dim}>
              <summary style={{ cursor: "pointer" }}>{i.errTail.length > 0 ? t("servers.pm2Move.job.errTitle") : t("servers.pm2Move.job.logTitle")}</summary>
              <pre className="mono" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11.5 }}>
                {[...i.errTail, ...i.logTail].join("\n")}
              </pre>
            </details>
          )}
        </div>
      ))}
      {job.state === "done" && (
        <>
          <p style={note()}>{t("servers.pm2Move.job.scanAgain")}</p>
          <div style={{ marginTop: 8 }}>
            <Btn variant="ghost" onClick={onAgain}>
              {t("servers.pm2Move.refresh")}
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}

function stepText(t: ReturnType<typeof useT>, step: string): string {
  const key = `servers.pm2Move.job.step.${step}`;
  const txt = t(key);
  return txt === key ? "" : txt;
}
