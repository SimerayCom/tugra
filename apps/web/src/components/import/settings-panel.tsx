"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { SectionCard, Btn, Spinner } from "../ui";
import { useToast } from "../toast";
import { CopyBtn } from "../copy-row";
import type { ImportRemoteKind } from "../../lib/types";
import {
  blockedKey,
  INLINE_NOTE_CODES,
  NOTE_KEY,
  RESULT_CODE_KEY,
  allEntries,
  buildApplyBody,
  duplicateServerEntries,
  initialSelection,
  missingInput,
  needsInviteConfirmation,
  readySelection,
  type SettingsApplyResult,
  type SettingsEntry,
  type SettingsInputs,
  type SettingsNote,
  type SettingsSection,
  type SettingsSectionPreview,
} from "../../lib/import-settings";

/** Literal keys so static key-usage checks keep working. */
const SECTION_TITLE: Record<SettingsSection, string> = {
  notifications: "import.settings.section.notifications.title",
  sharedVariables: "import.settings.section.sharedVariables.title",
  storages: "import.settings.section.storages.title",
  scheduledTasks: "import.settings.section.scheduledTasks.title",
  serverSettings: "import.settings.section.serverSettings.title",
  tags: "import.settings.section.tags.title",
  members: "import.settings.section.members.title",
};
const SECTION_HINT: Record<SettingsSection, string> = {
  notifications: "import.settings.section.notifications.hint",
  sharedVariables: "import.settings.section.sharedVariables.hint",
  storages: "import.settings.section.storages.hint",
  scheduledTasks: "import.settings.section.scheduledTasks.hint",
  serverSettings: "import.settings.section.serverSettings.hint",
  tags: "import.settings.section.tags.hint",
  members: "import.settings.section.members.hint",
};
const UNAVAILABLE_KEY = {
  not_exposed: "import.settings.unavailable.not_exposed",
  forbidden: "import.settings.unavailable.forbidden",
  error: "import.settings.unavailable.error",
} as const;
const CHANNEL_TYPE_KEY: Record<string, string> = {
  telegram: "import.settings.channelType.telegram",
  discord: "import.settings.channelType.discord",
  slack: "import.settings.channelType.slack",
  pushover: "import.settings.channelType.pushover",
  webhook: "import.settings.channelType.webhook",
  email: "import.settings.channelType.email",
};
const ROLE_KEY = { ADMIN: "import.settings.role.ADMIN", VIEWER: "import.settings.role.VIEWER" } as const;
const STATUS_KEY = { created: "import.settings.result.created", skipped: "import.settings.result.skipped", failed: "import.settings.result.failed" } as const;

const field = { width: "100%", minHeight: 44, boxSizing: "border-box", fontFamily: "inherit", fontSize: 14, padding: "8px 10px", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", background: "var(--c-el)", color: "var(--c-tx)" } as const;
const fieldLabel = { display: "block", fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 4px" } as const;

type T = (key: string, params?: Record<string, string | number>) => string;

function noteText(t: T, n: SettingsNote): string {
  const key = NOTE_KEY[n.code];
  return key ? t(key, n.params) : n.code;
}

/** The one-sentence summary under an entry's name. */
export function entrySummary(t: T, e: SettingsEntry): string {
  const d = e.detail;
  switch (e.section) {
    case "notifications": {
      const groups = (d.groups as Array<{ threadId?: string; coolifyEvents: string[] }>) ?? [];
      const n = groups.reduce((sum, g) => sum + g.coolifyEvents.length, 0);
      return n ? t("import.settings.summary.events", { n }) : t("import.settings.summary.noEvents");
    }
    case "sharedVariables":
      return d.scope === "team"
        ? t("import.settings.summary.scopeTeam")
        : d.scope === "project"
          ? t("import.settings.summary.scopeProject", { project: String(d.project ?? "") })
          : t("import.settings.summary.scopeEnvironment", { project: String(d.project ?? ""), environment: String(d.environment ?? "") });
    case "storages":
      return t("import.settings.summary.storage", { bucket: String(d.bucket ?? ""), endpoint: String(d.endpoint ?? "") });
    case "scheduledTasks":
      return t("import.settings.summary.task", { resource: String(d.resource ?? ""), schedule: String(d.schedule ?? "") });
    case "serverSettings":
      return d.thresholdPct ? t("import.settings.summary.serverThreshold", { schedule: String(d.schedule ?? ""), pct: String(d.thresholdPct) }) : t("import.settings.summary.server", { schedule: String(d.schedule ?? "") });
    case "tags":
      return t("import.settings.summary.tag", { imported: Number(d.imported ?? 0), total: Number(d.resources ?? 0) });
    case "members":
      return t("import.settings.summary.member", { role: t(ROLE_KEY[(d.suggestedRole as "ADMIN" | "VIEWER") ?? "VIEWER"]) });
  }
}

const entryTitle = (t: T, e: SettingsEntry): string => (e.section === "notifications" ? t(CHANNEL_TYPE_KEY[e.name] ?? "import.settings.channelType.webhook") : e.name);

/**
 * "Settings" section of the import preview: what the source holds besides apps (notification channels, shared variables, backup
 * storages, scheduled tasks, server cleanup, tags, members), each entry selectable. The hub reads it; this panel only shows the
 * secret-free preview and sends back ids, plus the few things the source cannot give (S3 keys) and the operator's confirmation
 * for invitations. After the import, each carried channel gets a "Send test message" button.
 */
export function ImportSettingsPanel({ sessionId, kind, opId, teamId, teamName, servers, agentConsent }: { sessionId: string; kind: ImportRemoteKind; opId?: string; teamId?: string; /** The Tugra team these settings go into, when known: said on the card, because notification tokens, variables and invitations are created there. */ teamName?: string; servers: Array<{ id: string; name: string }>; /** Agent session: what the owner's consent allows now. Undefined on the API-token path. */ agentConsent?: { classes: readonly string[] } }) {
  const t = useT();
  const toast = useToast();
  const q = useQuery({
    // the consent is part of the key: allowing more reads the settings again, so a channel that needed it becomes readable
    queryKey: ["import-settings", sessionId, opId ?? null, teamId ?? null, agentConsent ? [...agentConsent.classes].sort().join(",") : null],
    queryFn: () => api.importSettingsPreview({ sessionId, sourceKind: kind, ...(opId ? { opId } : {}), ...(teamId ? { teamId } : {}) }),
    enabled: !!sessionId && kind === "coolify",
    refetchOnWindowFocus: false, // every read goes to the source's rate-limited API: only on the operator's "Refresh"
    staleTime: Infinity,
    retry: false,
  });

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [s3, setS3] = useState<Record<string, { accessKey: string; secretKey: string }>>({});
  const [serverPick, setServerPick] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, "ADMIN" | "VIEWER">>({});
  const [confirmInvites, setConfirmInvites] = useState(false);
  const [result, setResult] = useState<{ data: SettingsApplyResult; names: Record<string, string> } | null>(null);
  const [initFor, setInitFor] = useState<unknown>(null);

  const preview = q.data;
  // Tick the hub's sensible defaults once per fresh read.
  useEffect(() => {
    if (preview && initFor !== preview) {
      setSelected(initialSelection(preview));
      setInitFor(preview);
    }
  }, [preview, initFor]);

  const entries = useMemo(() => (preview ? allEntries(preview) : []), [preview]);
  const inputs: SettingsInputs = useMemo(() => {
    const servers_: Record<string, string> = {};
    // No default target: the operator picks which Tugra server each source server's cleanup is for.
    for (const e of entries) if (e.needs?.includes("server")) servers_[e.id] = serverPick[e.id] ?? "";
    return { selected, s3, servers: servers_, roles, confirmInvites };
  }, [entries, selected, s3, serverPick, roles, confirmInvites]);
  const dupServers = useMemo(() => (preview ? duplicateServerEntries(preview, inputs) : new Set<string>()), [preview, inputs]);

  const apply = useMutation({
    mutationFn: () => api.importSettingsApply(buildApplyBody(preview!, inputs, { sessionId, sourceKind: kind, ...(opId ? { opId } : {}), ...(teamId ? { teamId } : {}) })),
    onSuccess: (data) => {
      const names = Object.fromEntries(entries.map((e) => [e.id, entryTitle(t, e)]));
      setResult({ data, names });
      setS3({}); // the keys are not kept around after they were sent
      setSelected((prev) => new Set([...prev].filter((id) => !data.results.some((r) => r.id === id && r.status !== "failed"))));
      toast(t("import.settings.importDone", data.counts), data.counts.failed > 0 ? "error" : "success");
      void q.refetch();
    },
    onError: (e) => toast((e as Error).message, "error"),
  });

  if (kind !== "coolify") return null;
  if (q.isLoading) {
    return (
      <SectionCard title={t("import.settings.title")} desc={t("import.settings.desc")}>
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx3)" }}><Spinner /> {t("import.settings.loading")}</div>
      </SectionCard>
    );
  }
  if (q.isError) {
    return (
      <SectionCard title={t("import.settings.title")} desc={t("import.settings.desc")}>
        <p role="alert" style={{ fontSize: 13, color: "var(--c-am)", margin: "0 0 10px", overflowWrap: "anywhere" }}>{t("import.settings.failed")}</p>
        <Btn variant="ghost" onClick={() => void q.refetch()}>{t("import.settings.retry")}</Btn>
      </SectionCard>
    );
  }
  if (!preview || !preview.supported) return null;

  const ready = readySelection(preview, inputs);
  const invites = needsInviteConfirmation(preview, inputs);
  const canApply = ready.length > 0 && (!invites || confirmInvites) && !apply.isPending;
  const toggle = (id: string, on: boolean) => setSelected((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });

  return (
    <SectionCard
      title={t("import.settings.title")}
      desc={t("import.settings.desc")}
      right={<Btn variant="ghost" onClick={() => void q.refetch()} disabled={q.isFetching}>{t("import.settings.refresh")}</Btn>}
      style={{ padding: 20, marginBottom: 0 }}
    >
      {teamName && <p data-testid="settings-team" style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 12px" }}>{t("import.settings.into", { team: teamName })}</p>}
      {preview.sections.map((s) => (
        <Section key={s.section} s={s} t={t} agentConsent={agentConsent} inputs={inputs} dupServers={dupServers} servers={servers} onToggle={toggle} onS3={(id, v) => setS3((p) => ({ ...p, [id]: v }))} onServer={(id, v) => setServerPick((p) => ({ ...p, [id]: v }))} onRole={(id, v) => setRoles((p) => ({ ...p, [id]: v }))} />
      ))}

      {invites && (
        <label style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, fontSize: 13, marginTop: 8 }}>
          <input type="checkbox" checked={confirmInvites} onChange={(e) => setConfirmInvites(e.target.checked)} style={{ width: 20, height: 20 }} />
          {t("import.settings.confirmInvites")}
        </label>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
        <Btn onClick={() => apply.mutate()} disabled={!canApply} loading={apply.isPending}>
          {apply.isPending ? t("import.settings.importing") : t("import.settings.import")}
        </Btn>
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("import.settings.selected", { n: ready.length })}</span>
      </div>

      {result && <ResultList result={result} t={t} />}
    </SectionCard>
  );
}

function Section({ s, t, agentConsent, inputs, dupServers, servers, onToggle, onS3, onServer, onRole }: {
  s: SettingsSectionPreview;
  t: T;
  agentConsent?: { classes: readonly string[] };
  inputs: SettingsInputs;
  dupServers: ReadonlySet<string>;
  servers: Array<{ id: string; name: string }>;
  onToggle: (id: string, on: boolean) => void;
  onS3: (id: string, v: { accessKey: string; secretKey: string }) => void;
  onServer: (id: string, v: string) => void;
  onRole: (id: string, v: "ADMIN" | "VIEWER") => void;
}) {
  return (
    <section aria-labelledby={`imp-set-${s.section}`} style={{ borderTop: "1px solid var(--c-bd)", padding: "12px 0" }}>
      <h4 id={`imp-set-${s.section}`} style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t(SECTION_TITLE[s.section])}</h4>
      <p style={{ margin: "2px 0 8px", fontSize: 12, color: "var(--c-tx3)" }}>{t(SECTION_HINT[s.section])}</p>
      {!s.available ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t(UNAVAILABLE_KEY[s.reason ?? "error"])}</p>
      ) : (
        <>
          {s.partial && <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--c-am)" }}>{t("import.settings.partial")}</p>}
          {s.entries.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("import.settings.empty")}</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {s.entries.map((e) => (
                <EntryRow key={e.id} e={e} t={t} agentConsent={agentConsent} inputs={inputs} duplicate={dupServers.has(e.id)} servers={servers} onToggle={onToggle} onS3={onS3} onServer={onServer} onRole={onRole} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function EntryRow({ e, t, agentConsent, inputs, duplicate, servers, onToggle, onS3, onServer, onRole }: {
  e: SettingsEntry;
  t: T;
  agentConsent?: { classes: readonly string[] };
  inputs: SettingsInputs;
  duplicate: boolean;
  servers: Array<{ id: string; name: string }>;
  onToggle: (id: string, on: boolean) => void;
  onS3: (id: string, v: { accessKey: string; secretKey: string }) => void;
  onServer: (id: string, v: string) => void;
  onRole: (id: string, v: "ADMIN" | "VIEWER") => void;
}) {
  const checked = inputs.selected.has(e.id);
  const boxId = `imp-set-box-${e.id}`;
  const missing = checked ? missingInput(e, inputs) : null;
  const creds = inputs.s3[e.id] ?? { accessKey: "", secretKey: "" };
  const groups = e.section === "notifications" ? ((e.detail.groups as Array<{ threadId?: string; events?: Array<{ from: string; to: string[] }> }>) ?? []) : [];
  const inlineNotes = e.selectable ? e.notes.filter((n) => INLINE_NOTE_CODES.has(n.code)) : [];
  const moreNotes = e.notes.filter((n) => !inlineNotes.includes(n));
  return (
    <li style={{ borderBottom: "1px solid var(--c-bd)", paddingBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <input id={boxId} type="checkbox" checked={checked && e.selectable} disabled={!e.selectable} onChange={(ev) => onToggle(e.id, ev.target.checked)} style={{ width: 20, height: 20, marginTop: 12, flexShrink: 0 }} />
        <label htmlFor={boxId} style={{ flex: 1, minHeight: 44, display: "flex", flexDirection: "column", justifyContent: "center", cursor: e.selectable ? "pointer" : "not-allowed", opacity: e.selectable ? 1 : 0.7 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{entryTitle(t, e)}</span>
          <span style={{ fontSize: 12, color: "var(--c-tx3)", overflowWrap: "anywhere" }}>{e.blocked ? t(blockedKey(e, agentConsent)) : entrySummary(t, e)}</span>
        </label>
      </div>

      {inlineNotes.length > 0 && (
        <ul style={{ margin: "2px 0 4px", paddingLeft: 48, fontSize: 12, color: "var(--c-am)" }}>
          {inlineNotes.map((n, i) => <li key={i}>{noteText(t, n)}</li>)}
        </ul>
      )}
      {checked && e.selectable && e.needs?.includes("s3Credentials") && (
        <div style={{ paddingLeft: 30, maxWidth: 420 }}>
          <label style={fieldLabel} htmlFor={`${boxId}-ak`}>{t("import.settings.field.accessKey")}</label>
          <input id={`${boxId}-ak`} style={field} value={creds.accessKey} onChange={(ev) => onS3(e.id, { ...creds, accessKey: ev.target.value })} autoComplete="off" spellCheck={false} />
          <label style={fieldLabel} htmlFor={`${boxId}-sk`}>{t("import.settings.field.secretKey")}</label>
          <input id={`${boxId}-sk`} style={field} type="password" value={creds.secretKey} onChange={(ev) => onS3(e.id, { ...creds, secretKey: ev.target.value })} autoComplete="new-password" />
        </div>
      )}
      {checked && e.selectable && e.needs?.includes("server") && (
        <div style={{ paddingLeft: 30, maxWidth: 420 }}>
          <label style={fieldLabel} htmlFor={`${boxId}-srv`}>{t("import.settings.field.server")}</label>
          <select id={`${boxId}-srv`} style={field} value={inputs.servers[e.id] ?? ""} onChange={(ev) => onServer(e.id, ev.target.value)}>
            <option value="">{t("import.settings.field.pickServer")}</option>
            {servers.map((sv) => <option key={sv.id} value={sv.id}>{sv.name}</option>)}
          </select>
        </div>
      )}
      {checked && e.selectable && e.needs?.includes("role") && (
        <div style={{ paddingLeft: 30, maxWidth: 420 }}>
          <label style={fieldLabel} htmlFor={`${boxId}-role`}>{t("import.settings.field.role")}</label>
          <select id={`${boxId}-role`} style={field} value={inputs.roles[e.id] ?? (e.detail.suggestedRole as "ADMIN" | "VIEWER") ?? "VIEWER"} onChange={(ev) => onRole(e.id, ev.target.value as "ADMIN" | "VIEWER")}>
            <option value="ADMIN">{t(ROLE_KEY.ADMIN)}</option>
            <option value="VIEWER">{t(ROLE_KEY.VIEWER)}</option>
          </select>
        </div>
      )}
      {duplicate && <p role="alert" style={{ margin: "6px 0 0 30px", fontSize: 12, color: "var(--c-am)" }}>{t("import.settings.serverDuplicate")}</p>}
      {missing && <p role="status" style={{ margin: "6px 0 0 30px", fontSize: 12, color: "var(--c-am)" }}>{t("import.settings.needsInput")}</p>}

      {(moreNotes.length > 0 || groups.length > 0) && (
        <details style={{ paddingLeft: 30, marginTop: 4 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--c-tx3)", minHeight: 32, display: "flex", alignItems: "center" }}>{t("import.settings.more")}</summary>
          {groups.length > 0 && (
            <ul style={{ margin: "4px 0", paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)" }}>
              {groups.map((g, i) => (
                <li key={i}>
                  {g.threadId ? `${t("import.settings.summary.topic", { id: g.threadId })}` : ""}
                  <ul style={{ margin: "2px 0", paddingLeft: 16, listStyle: "none" }}>
                    {(g.events ?? []).map((ev) => (
                      <li key={ev.from} className="mono" style={{ overflowWrap: "anywhere" }}>{t("import.settings.summary.eventMap", { from: ev.from, to: ev.to.join(", ") })}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {moreNotes.length > 0 && (
            <ul style={{ margin: "4px 0", paddingLeft: 18, fontSize: 12 }}>
              {moreNotes.map((n, i) => <li key={i} style={{ color: n.level === "warn" ? "var(--c-am)" : "var(--c-tx3)" }}>{noteText(t, n)}</li>)}
            </ul>
          )}
        </details>
      )}
    </li>
  );
}

/** One carried channel with its "Send test message" button (the hub's own channel test; the result is shown, never assumed). */
function TestChannel({ id, name, t }: { id: string; name: string; t: T }) {
  const toast = useToast();
  const test = useMutation({
    mutationFn: () => api.testChannel(id),
    onSuccess: () => toast(t("import.settings.testOk"), "success"),
    onError: () => toast(t("import.settings.testFailed"), "error"),
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
      <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{name}</span>
      <Btn variant="ghost" onClick={() => test.mutate()} loading={test.isPending} style={{ minHeight: 44 }}>
        {test.isPending ? t("import.settings.testing") : t("import.settings.test")}
      </Btn>
    </div>
  );
}

function ResultList({ result, t }: { result: { data: SettingsApplyResult; names: Record<string, string> }; t: T }) {
  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}>
      <h4 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600 }}>{t("import.settings.result.title")}</h4>
      {result.data.results.some((r) => (r.channels ?? []).some((c) => !c.skipped && c.id)) && <p role="status" style={{ margin: "0 0 8px", fontSize: 12, color: "var(--c-am)" }}>{t("import.settings.result.doubleSend")}</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {result.data.results.map((r) => (
          <li key={r.id} style={{ fontSize: 13 }}>
            <span style={{ fontWeight: 600, color: r.status === "created" ? "var(--c-g)" : r.status === "failed" ? "var(--c-r)" : "var(--c-tx3)" }}>{t(STATUS_KEY[r.status])}</span>{" "}
            <span className="mono" style={{ overflowWrap: "anywhere" }}>{result.names[r.id] ?? r.id}</span>
            {r.code && <span style={{ color: "var(--c-tx3)" }}> - {t(RESULT_CODE_KEY[r.code] ?? "import.settings.result.code.failed")}</span>}
            {(r.channels ?? []).filter((c) => !c.skipped && c.id).map((c) => <TestChannel key={c.id} id={c.id} name={c.name} t={t} />)}
            {r.recoveryKey && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, color: "var(--c-am)" }}>{t("import.settings.recovery.title")}: {t("import.settings.recovery.body")}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <code className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{r.recoveryKey}</code>
                  <CopyBtn text={r.recoveryKey} />
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
