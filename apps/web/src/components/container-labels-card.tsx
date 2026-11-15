"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus, X } from "lucide-react";
import { api } from "../lib/api";
import type { AppLabelsView, AppliedLabel } from "../lib/types";
import { useT } from "../i18n/provider";
import { ConfigCard, TextInput, useSaveFeedback } from "./form";
import { useConfirm } from "./confirm";
import { CopyBtn } from "./copy-row";
import { Btn, SectionCard } from "./ui";

type Row = { id: number; key: string; value: string };

// Reason text per reserved prefix. The PREFIX LIST itself always comes from the server (GET labels); this only
// maps a prefix it reports to the sentence explaining it, falling back to the generic Tugra one.
const WHY_KEY: Record<string, string> = {
  "traefik.": "apps.labelsWhyTraefik",
  "tugra.": "apps.labelsWhyTugra",
  "com.docker.compose.": "apps.labelsWhyCompose",
  "com.docker.swarm.": "apps.labelsWhySwarm",
  "com.docker.stack.": "apps.labelsWhyStack",
};
const PURPOSE_KEY: Record<AppliedLabel["purpose"], string> = {
  traefik_routing: "apps.labelsPurposeTraefikRouting",
  proxy_network_pin: "apps.labelsPurposeProxyNetworkPin",
  alias: "apps.labelsPurposeAlias",
  config_mount_fp: "apps.labelsPurposeConfigMountFp",
};
const NOTE_KEY: Record<AppLabelsView["notes"][number], string> = {
  rolling_health_labels: "apps.labelsNoteRollingHealth",
  needs_domain: "apps.labelsNoteNeedsDomain",
  compose_user_labels: "apps.labelsNoteComposeUserLabels",
  image_labels_not_shown: "apps.labelsNoteImageLabels",
  swarm_container_labels: "apps.labelsNoteSwarmContainer",
  swarm_runtime_labels: "apps.labelsNoteSwarmRuntime",
};

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

let rowSeq = 0;
const toRows = (m: Record<string, string> | null): Row[] =>
  Object.keys(m ?? {})
    .sort(cmp)
    .map((key) => ({ id: ++rowSeq, key, value: (m as Record<string, string>)[key] }));

/** Rows that carry anything (a fully blank row is a placeholder and is ignored on save). */
const filled = (rows: Row[]) => rows.filter((r) => r.key.trim() !== "" || r.value !== "");

/** Sorted `{key: value}` of the filled rows, the exact body the PUT sends (and what dirty compares). */
const toMap = (rows: Row[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of filled(rows).sort((a, b) => cmp(a.key.trim(), b.key.trim()))) out[r.key.trim()] = r.value;
  return out;
};

/** Parse pasted `KEY=VALUE` lines: split at the FIRST `=`, skip blank lines and `#` comments. */
export function parsePasted(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const eq = l.indexOf("=");
    out.push(eq === -1 ? { key: l, value: "" } : { key: l.slice(0, eq).trim(), value: l.slice(eq + 1) });
  }
  return out;
}

/**
 * Container labels for an app. The top section lists, read-only, every label Tugra applies (derived on each
 * deploy by the same builders the deploy uses; secret values are masked by the server). Below it, classic and
 * swarm apps get an editor for the operator's own labels; compose and preview apps get a note instead. The
 * reserved namespaces, limits and key pattern come from the GET response, never from a list in the web.
 */
export function ContainerLabelsCard({
  id,
  source,
  clusterId,
  isPreview,
  customLabels,
}: {
  id: string;
  source: string;
  clusterId: string | null;
  isPreview: boolean;
  customLabels: Record<string, string> | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const feedback = useSaveFeedback("apps.saved");
  const confirm = useConfirm();
  const view = useQuery({ queryKey: ["app", id, "labels"], queryFn: () => api.getAppLabels(id) });
  const data = view.data;

  const compose = source === "COMPOSE";
  const editable = !compose && !isPreview;
  const storedKey = JSON.stringify(customLabels ?? {});
  const [rows, setRows] = useState<Row[]>(() => toRows(customLabels));
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  // Re-seed when the server's stored map changes out from under the form (after a save / reset).
  useEffect(() => setRows(toRows(customLabels)), [storedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["app", id] });
    qc.invalidateQueries({ queryKey: ["app", id, "labels"] });
  };
  const save = useMutation({
    mutationFn: (labels: Record<string, string>) => api.setAppCustomLabels(id, labels),
    onSuccess: invalidate,
    ...feedback,
  });

  const errors = useMemo(() => {
    const byRow = new Map<number, string>();
    let tooMany: string | null = null;
    if (!data) return { byRow, tooMany };
    const re = new RegExp(data.limits.keyPattern);
    const seen = new Map<string, number>();
    const list = filled(rows);
    if (list.length > data.limits.maxCount) tooMany = t("apps.labelsTooMany", { max: data.limits.maxCount });
    for (const r of list) {
      const key = r.key.trim();
      const lower = key.toLowerCase();
      const prefix = data.reservedPrefixes.find((p) => lower.startsWith(p));
      if (prefix) byRow.set(r.id, t("apps.labelsReserved", { key, why: t(WHY_KEY[prefix] ?? "apps.labelsWhyTugra") }));
      else if (!key || key.length > data.limits.keyMax || !re.test(key)) byRow.set(r.id, t("apps.labelsInvalidKey", { key }));
      else if (seen.has(lower)) byRow.set(r.id, t("apps.labelsDuplicate", { key }));
      else if (r.value.length > data.limits.valueMax || CONTROL_RE.test(r.value)) byRow.set(r.id, t("apps.labelsValueInvalid", { key }));
      if (key) seen.set(lower, r.id);
    }
    return { byRow, tooMany };
  }, [rows, data, t]);

  const patch = (rid: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === rid ? { ...r, ...p } : r)));
  const addRow = () => setRows((rs) => [...rs, { id: ++rowSeq, key: "", value: "" }]);
  const applyPaste = () => {
    setRows((rs) => {
      let next = rs.filter((r) => r.key.trim() !== "" || r.value !== "");
      for (const p of parsePasted(pasteText)) {
        next = next.filter((r) => r.key.trim().toLowerCase() !== p.key.toLowerCase());
        next.push({ id: ++rowSeq, key: p.key, value: p.value });
      }
      return next;
    });
    setPasteText("");
    setPasteOpen(false);
  };
  const reset = async () => {
    const ok = await confirm({ title: t("apps.labelsResetConfirmTitle"), body: t("apps.labelsResetConfirmBody"), danger: true });
    if (ok) save.mutate({});
  };

  const current = toMap(rows);
  const dirty = JSON.stringify(current) !== storedKey;
  const hasError = errors.byRow.size > 0 || errors.tooMany !== null;
  const hasStored = Object.keys(customLabels ?? {}).length > 0;

  const applied = (
    <div style={{ marginBottom: editable || compose || isPreview ? 18 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 4 }}>
        <Lock size={13} aria-hidden /> {t("apps.labelsApplied")}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px", lineHeight: 1.5 }}>{t("apps.labelsAppliedHint")}</p>
      {view.isLoading && <p style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("common.loading")}</p>}
      {view.isError && <p role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("apps.labelsLoadFailed")}</p>}
      {data && <AppliedList data={data} />}
    </div>
  );

  const body = (
    <>
      {applied}
      {editable && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 8 }}>{t("apps.labelsCustom")}</div>
          {clusterId && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px", lineHeight: 1.5 }}>{t("apps.labelsSwarmNote")}</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r) => {
              const err = errors.byRow.get(r.id);
              return (
                <div key={r.id}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <TextInput
                      mono
                      aria-label={t("apps.labelsKey")}
                      aria-invalid={err ? true : undefined}
                      placeholder="key"
                      value={r.key}
                      onChange={(e) => patch(r.id, { key: e.target.value })}
                      spellCheck={false}
                      autoComplete="off"
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <TextInput
                      mono
                      aria-label={t("apps.labelsValue")}
                      placeholder="value"
                      value={r.value}
                      onChange={(e) => patch(r.id, { value: e.target.value })}
                      spellCheck={false}
                      autoComplete="off"
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <Btn variant="ghost" icon={X} aria-label={t("apps.labelsRemove")} onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} />
                  </div>
                  {err && <div role="alert" style={{ fontSize: 11, color: "var(--c-r)", marginTop: 4 }}>{err}</div>}
                </div>
              );
            })}
          </div>
          {errors.tooMany && <div role="alert" style={{ fontSize: 11, color: "var(--c-r)", marginTop: 6 }}>{errors.tooMany}</div>}
          {pasteOpen && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <textarea
                aria-label={t("apps.labelsPaste")}
                className="mono"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={t("apps.labelsPastePlaceholder")}
                rows={4}
                spellCheck={false}
                style={{ width: "100%", boxSizing: "border-box", fontSize: 12, padding: 8, background: "var(--c-el)", color: "var(--c-tx)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", resize: "vertical" }}
              />
              <div><Btn variant="ghost" onClick={applyPaste} disabled={!pasteText.trim()}>{t("apps.labelsPasteApply")}</Btn></div>
            </div>
          )}
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "10px 0 0" }}>{t("apps.labelsAppliedNextDeploy")}</p>
          {data && data.fromDockerOptions.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 4 }}>
                <Lock size={13} aria-hidden /> {t("apps.labelsFromDockerOptions")}
              </div>
              <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px", lineHeight: 1.5 }}>{t("apps.labelsFromDockerOptionsHint")}</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                {data.fromDockerOptions.map((l, i) => (
                  <li key={`${l.key}-${i}`}>
                    <code className="mono" style={{ fontSize: 12 }}>{l.key}={l.value}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {compose && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0, lineHeight: 1.5 }}>{t("apps.labelsComposeNote")}</p>}
      {!compose && isPreview && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0, lineHeight: 1.5 }}>{t("apps.labelsPreviewNote")}</p>}
    </>
  );

  if (!editable) {
    return (
      <SectionCard title={t("apps.containerLabels")} desc={t("apps.containerLabelsDesc")}>
        {body}
      </SectionCard>
    );
  }
  return (
    <ConfigCard
      title={t("apps.containerLabels")}
      desc={t("apps.containerLabelsDesc")}
      dirty={dirty}
      saving={save.isPending}
      saveDisabled={hasError || !data}
      onSave={() => save.mutate(current)}
      actions={
        <>
          <Btn variant="ghost" icon={Plus} onClick={addRow}>{t("apps.labelsAdd")}</Btn>
          <Btn variant="ghost" onClick={() => setPasteOpen((o) => !o)} aria-expanded={pasteOpen}>{t("apps.labelsPaste")}</Btn>
          <Btn variant="dangerGhost" onClick={reset} disabled={!hasStored || save.isPending}>{t("apps.labelsReset")}</Btn>
        </>
      }
    >
      {body}
    </ConfigCard>
  );
}

/** The read-only Tugra labels, grouped by scope, with a purpose badge and a copy button per row. */
function AppliedList({ data }: { data: AppLabelsView }) {
  const t = useT();
  const groups = useMemo(() => {
    const m = new Map<string, AppliedLabel[]>();
    for (const l of data.tugra) (m.get(l.scope) ?? m.set(l.scope, []).get(l.scope)!).push(l);
    return [...m.entries()];
  }, [data.tugra]);
  const scopeTitle = (scope: string) =>
    scope === "container" ? t("apps.labelsScopeContainer") : scope === "swarm-service" ? t("apps.labelsScopeSwarmService") : t("apps.labelsScopeService", { name: scope.replace(/^service:/, "") });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {groups.length === 0 && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("apps.labelsNoneApplied")}</p>}
      {groups.map(([scope, labels]) => (
        <div key={scope}>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 4px" }}>{scopeTitle(scope)}</div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {labels.map((l) => (
              <li key={l.key} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <code className="mono" style={{ fontSize: 12, flexShrink: 0, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.key}>{l.key}</code>
                <code className="mono" style={{ fontSize: 12, color: "var(--c-tx2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.masked ? undefined : (l.value ?? "")}>
                  {l.masked ? t("apps.labelsMasked") : l.value}
                </code>
                <span style={{ fontSize: 10, color: "var(--c-tx3)", border: "1px solid var(--c-bd)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>{t(PURPOSE_KEY[l.purpose])}</span>
                {l.masked ? <CopyBtn text={l.key} label={t("apps.labelsCopyKey")} /> : <CopyBtn text={`${l.key}=${l.value ?? ""}`} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {data.notes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>
          {data.notes.map((n) => (
            <li key={n}>{t(NOTE_KEY[n])}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
