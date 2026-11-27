"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { defaultChannelSelection, defaultMonitorSelection } from "../lib/monitors";
import type { KumaApplyResult, KumaContainer, KumaPlan, KumaSource, KumaWarning } from "../lib/types";
import { Btn, Card, Working } from "./ui";
import { Checkbox, Field, Select } from "./form";

const MAX_FILE_CHARS = 3_500_000; // the hub accepts a little under 4 MB of JSON per request

type SourceKind = "backup" | "server";

/** File text, with a FileReader fallback for runtimes whose Blob has no text(). */
function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

const chip = (color: string): React.CSSProperties => ({
  fontSize: 11,
  fontWeight: 600,
  color,
  border: `1px solid ${color}`,
  borderRadius: 4,
  padding: "1px 6px",
  whiteSpace: "nowrap",
});

/** One localized warning line. */
function warningText(t: ReturnType<typeof useT>, w: KumaWarning): string {
  return t(`monitors.kuma.warning.${w.code}`, w.params ?? {});
}

/** A localized message for a failed call: the hub's stable error code when we know it, else a generic line. */
function errorText(t: ReturnType<typeof useT>, e: unknown): string {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code) {
    const key = `monitors.kuma.error.${code}`;
    const text = t(key);
    if (text !== key) return text;
  }
  return e instanceof ApiError && e.status === 403 ? e.message : t("monitors.kuma.error.generic");
}

/** The whole import flow: pick a source, dry-run preview, confirm, apply. */
export function KumaImport() {
  const t = useT();
  const qc = useQueryClient();

  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [teamId, setTeamId] = useState("");
  const [kind, setKind] = useState<SourceKind>("backup");
  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState(false);
  const [serverId, setServerId] = useState("");
  const [containers, setContainers] = useState<KumaContainer[] | null>(null);
  const [container, setContainer] = useState("");

  const [plan, setPlan] = useState<KumaPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [channelSel, setChannelSel] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<KumaApplyResult | null>(null);

  const { data: servers = [], isFetching: loadingServers } = useQuery({
    queryKey: ["servers", teamId],
    queryFn: () => api.listServers({ teamId }),
    enabled: !!teamId && kind === "server",
  });

  const source = useMemo<KumaSource | null>(() => {
    if (kind === "backup") return fileText ? { kind: "backup", json: fileText } : null;
    if (!serverId) return null;
    return { kind: "server", serverId, ...(container ? { container } : {}) };
  }, [kind, fileText, serverId, container]);

  const detect = useMutation({
    mutationFn: () => api.kumaDetect({ teamId, serverId }),
    onSuccess: (r) => {
      const usable = r.containers.filter((c) => c.hasData);
      setContainers(usable);
      setContainer(usable.length === 1 ? usable[0].container : "");
    },
  });

  const preview = useMutation({
    mutationFn: () => api.kumaPreview({ teamId, source: source as KumaSource }),
    onSuccess: (p) => {
      const sel = defaultMonitorSelection(p);
      setPlan(p);
      setSelected(sel);
      setChannelSel(defaultChannelSelection(p, sel));
      setResult(null);
    },
  });

  const apply = useMutation({
    mutationFn: () =>
      api.kumaApply({
        teamId,
        source: source as KumaSource,
        monitorRefs: [...selected],
        createChannelRefs: [...channelSel],
      }),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ["monitors"] });
      qc.invalidateQueries({ queryKey: ["channels"] });
    },
  });

  const onFile = async (file: File | undefined) => {
    setFileError(false);
    setFileText("");
    setFileName("");
    setPlan(null);
    if (!file) return;
    const text = await readText(file);
    if (text.length > MAX_FILE_CHARS) {
      setFileError(true);
      return;
    }
    setFileText(text);
    setFileName(file.name);
  };

  const toggle = (set: Set<string>, ref: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(ref);
    else next.delete(ref);
    return next;
  };

  const startOver = () => {
    setPlan(null);
    setResult(null);
    setSelected(new Set());
    setChannelSel(new Set());
  };

  const canPreview = !!teamId && !!source && (kind === "backup" || (containers !== null && containers.length > 0 && !!container));

  // ── done ──
  if (result) {
    const failed = result.totals.monitorsFailed + result.totals.channelsFailed;
    const failures = [...result.channels, ...result.monitors].filter((r) => r.status === "failed");
    return (
      <Card style={{ padding: 16 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>{t("monitors.kuma.doneTitle")}</h2>
        <p role="status" style={{ margin: "0 0 8px", color: "var(--c-tx2)", fontSize: 14 }}>
          {t("monitors.kuma.doneSummary", { monitors: result.totals.monitorsCreated, channels: result.totals.channelsCreated })}
        </p>
        {failed > 0 && (
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: "pointer", color: "var(--c-r)", fontSize: 13, minHeight: 44, display: "flex", alignItems: "center" }}>
              {t("monitors.kuma.doneFailed", { n: failed })} · {t("monitors.kuma.more")}
            </summary>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)" }}>
              {failures.map((f) => (
                <li key={`${f.ref}-${f.name}`}>
                  {f.name}: {f.error}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href="/monitors" style={{ textDecoration: "none" }}>
            <Btn>{t("monitors.kuma.viewMonitors")}</Btn>
          </Link>
          <Btn variant="ghost" onClick={startOver}>{t("monitors.kuma.startOver")}</Btn>
        </div>
      </Card>
    );
  }

  // ── preview ──
  if (plan) {
    const importable = plan.monitors.filter((m) => m.action === "create");
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Card style={{ padding: 16 }}>
          <p style={{ margin: 0, fontSize: 14 }}>
            {t("monitors.kuma.summary", { create: plan.totals.create, exists: plan.totals.exists, unsupported: plan.totals.unsupported })}
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--c-tx3)" }}>{t("monitors.kuma.previewNote")}</p>
        </Card>

        <Card style={{ padding: 16 }}>
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>{t("monitors.kuma.monitors")}</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {plan.monitors.map((m) => {
              const isNew = m.action === "create";
              return (
                <li key={m.ref} style={{ borderTop: "1px solid var(--c-bd)", padding: "4px 0", minHeight: 44 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 44 }}>
                    {isNew ? (
                      <Checkbox
                        checked={selected.has(m.ref)}
                        onChange={(on) => setSelected((s) => toggle(s, m.ref, on))}
                        label={<span style={{ fontWeight: 600, color: "var(--c-tx)" }}>{m.name}</span>}
                      />
                    ) : (
                      <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx2)" }}>{m.name}</span>
                    )}
                    <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", overflowWrap: "anywhere", flex: "1 1 160px" }}>
                      {m.type ?? m.kumaType}
                      {m.target ? ` · ${m.target}` : ""}
                    </span>
                    <span style={chip(isNew ? "var(--c-g)" : m.action === "exists" ? "var(--c-tx3)" : "var(--c-am)")}>
                      {t(`monitors.kuma.status.${m.action}`)}
                    </span>
                  </div>
                  {(m.reason || m.warnings.length > 0) && (
                    <details style={{ marginLeft: 26 }}>
                      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--c-tx3)", minHeight: 32, display: "flex", alignItems: "center" }}>
                        {m.reason ? t(`monitors.kuma.reason.${m.reason}`) : t("monitors.kuma.more")}
                      </summary>
                      <ul style={{ margin: "0 0 6px", paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)" }}>
                        {m.warnings.map((w, i) => (
                          <li key={i}>{warningText(t, w)}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        {plan.channels.length > 0 && (
          <Card style={{ padding: 16 }}>
            <h2 style={{ fontSize: 14, margin: "0 0 4px" }}>{t("monitors.kuma.channels")}</h2>
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--c-tx3)" }}>{t("monitors.kuma.channelsHint")}</p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {plan.channels.map((c) => (
                <li key={c.ref} style={{ borderTop: "1px solid var(--c-bd)", padding: "4px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 44 }}>
                    {c.action === "create" ? (
                      <Checkbox
                        checked={channelSel.has(c.ref)}
                        onChange={(on) => setChannelSel((s) => toggle(s, c.ref, on))}
                        label={
                          <span>
                            <span style={{ fontWeight: 600, color: "var(--c-tx)" }}>{c.name}</span>{" "}
                            <span style={{ color: "var(--c-tx3)" }}>({c.type}) · {t("monitors.kuma.channelCreate")}</span>
                          </span>
                        }
                      />
                    ) : (
                      <span style={{ fontSize: 13, color: "var(--c-tx2)" }}>
                        <span style={{ fontWeight: 600 }}>{c.name}</span>
                        <span style={{ color: "var(--c-tx3)" }}>
                          {" "}({c.type ?? c.kumaType}) · {c.action === "reuse" ? t("monitors.kuma.channelReuse") : t(`monitors.kuma.reason.${c.reason ?? "type"}`)}
                        </span>
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("monitors.kuma.usedBy", { n: c.usedBy })}</span>
                  </div>
                  {c.warnings.length > 0 && (
                    <details style={{ marginLeft: 26 }}>
                      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--c-tx3)", minHeight: 32, display: "flex", alignItems: "center" }}>
                        {t("monitors.kuma.more")}
                      </summary>
                      <ul style={{ margin: "0 0 6px", paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)" }}>
                        {c.warnings.map((w, i) => (
                          <li key={i}>{warningText(t, w)}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Btn onClick={() => apply.mutate()} disabled={apply.isPending || selected.size === 0} loading={apply.isPending}>
            {apply.isPending ? t("monitors.kuma.importing") : t("monitors.kuma.import", { n: selected.size })}
          </Btn>
          <Btn variant="ghost" onClick={startOver} disabled={apply.isPending}>{t("monitors.kuma.startOver")}</Btn>
          {importable.length > 0 && selected.size === 0 && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("monitors.kuma.noneSelected")}</span>}
        </div>
        {apply.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 13 }}>{errorText(t, apply.error)}</div>}
      </div>
    );
  }

  // ── source ──
  return (
    <Card style={{ padding: 16 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canPreview) preview.mutate();
        }}
        style={{ display: "grid", gap: 16 }}
      >
        <Field label={t("common.team")} htmlFor="kuma-team">
          <Select id="kuma-team" value={teamId} onChange={(v) => { setTeamId(v); setServerId(""); setContainers(null); setContainer(""); }}
            autoSelectFirst required placeholder={t("common.pickTeam")} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
        </Field>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t("monitors.kuma.sourceTitle")}</legend>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            {(["backup", "server"] as const).map((k) => (
              <label
                key={k}
                style={{
                  display: "flex", gap: 10, alignItems: "flex-start", padding: 12, minHeight: 44, cursor: "pointer",
                  border: `1px solid ${kind === k ? "var(--c-a)" : "var(--c-bd)"}`, borderRadius: "var(--r2)",
                }}
              >
                <input type="radio" name="kuma-source" checked={kind === k} onChange={() => { setKind(k); setPlan(null); }} style={{ marginTop: 3 }} />
                <span>
                  <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>{t(k === "backup" ? "monitors.kuma.sourceBackup" : "monitors.kuma.sourceServer")}</span>
                  <span style={{ display: "block", fontSize: 12, color: "var(--c-tx3)" }}>{t(k === "backup" ? "monitors.kuma.sourceBackupHint" : "monitors.kuma.sourceServerHint")}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {kind === "backup" ? (
          <Field label={t("monitors.kuma.file")} htmlFor="kuma-file">
            <input
              id="kuma-file"
              type="file"
              accept="application/json,.json"
              onChange={(e) => void onFile(e.target.files?.[0])}
              style={{ minHeight: 44, fontSize: 13 }}
            />
            {fileName && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 4 }}>{t("monitors.kuma.fileReady", { name: fileName })}</div>}
            {fileError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 4 }}>{t("monitors.kuma.fileTooLarge")}</div>}
          </Field>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <Field label={t("monitors.kuma.server")} htmlFor="kuma-server" hint={t("monitors.kuma.readOnly")}>
              <Select id="kuma-server" value={serverId} onChange={(v) => { setServerId(v); setContainers(null); setContainer(""); }}
                placeholder={loadingServers && servers.length === 0 ? t("common.loading") : servers.length === 0 ? t("monitors.kuma.noServers") : t("common.select")}
                options={servers.map((s) => ({ value: s.id, label: s.name }))} />
              {loadingServers && servers.length === 0 && <Working text={t("monitors.kuma.loadingServers")} />}
            </Field>
            <div>
              <Btn variant="ghost" onClick={() => detect.mutate()} disabled={!serverId || detect.isPending} loading={detect.isPending}>
                {detect.isPending ? t("monitors.kuma.finding") : t("monitors.kuma.find")}
              </Btn>
            </div>
            {containers && containers.length === 0 && <div role="status" style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("monitors.kuma.noKuma")}</div>}
            {containers && containers.length > 1 && (
              <Field label={t("monitors.kuma.container")} htmlFor="kuma-container">
                <Select id="kuma-container" value={container} onChange={setContainer} required
                  options={containers.map((c) => ({ value: c.container, label: `${c.container} (${c.image})` }))} />
              </Field>
            )}
            {detect.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 13 }}>{errorText(t, detect.error)}</div>}
          </div>
        )}

        <div>
          <Btn type="submit" disabled={!canPreview || preview.isPending} loading={preview.isPending}>
            {preview.isPending ? t("monitors.kuma.previewing") : t("monitors.kuma.preview")}
          </Btn>
        </div>
        {preview.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 13 }}>{errorText(t, preview.error)}</div>}
      </form>
    </Card>
  );
}
