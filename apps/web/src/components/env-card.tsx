"use client";

import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { AlertCircle, AlertTriangle, ArrowDownAZ, Check, Copy, Eye, EyeOff, FileText, Plus, SlidersHorizontal, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { copyText } from "../lib/clipboard";
import { useAutoMask } from "../lib/use-auto-mask";
import { parseDotenv, toDotenv, duplicateKeys, invalidKeys, envDirty } from "../lib/dotenv";
import { DEFAULT_FLAGS, applyBulkFlags, budgetIssues, canonicalFlags, flagsPayload, hasLineBreak, lineCount, looksSensitiveKey, rowIssues, type EnvFlagView } from "../lib/env-flags";
import { Badge, Btn, SectionCard, Spinner } from "./ui";
import { useOptionalConfirm } from "./confirm";
import { ErrorState } from "./error-state";
import { IconBtn } from "./icon-btn";
import { useToast } from "./toast";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";

// Env vars read best in a monospace field; value is a password field until revealed.
const envField: CSSProperties = {
  padding: "6px 9px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "var(--font-mono, monospace)",
  minWidth: 0,
  boxSizing: "border-box",
};

// `flags` and the options-panel state live IN the row object so they follow sort / delete / reindex.
type Row = { key: string; value: string; flags: EnvFlagView; optsOpen: boolean };
const newRow = (key = "", value = "", flags: EnvFlagView = DEFAULT_FLAGS): Row => ({ key, value, flags, optsOpen: false });

/**
 * Edit an app's environment variables. Values are masked by default and auto-re-mask (30s / tab
 * hidden); the server replaces the whole blob on save, so Save stays disabled until the env has
 * loaded and actually changed, and a duplicate key blocks the save (a map would silently drop one).
 * Read-only viewers can reveal and copy but see no editing controls or Save.
 */
export function EnvCard({
  id,
  clusterId,
  canWrite,
  title,
  desc,
  redeployHint,
  fetchEnv,
  saveEnv,
  queryKey,
  relatedKey,
  flagsEnabled = false,
}: {
  id: string;
  clusterId?: string | null;
  canWrite: boolean;
  // Data-source overrides (default to the app endpoints) so the same editor serves databases too.
  title?: string;
  desc?: string;
  redeployHint?: string;
  fetchEnv?: () => Promise<Record<string, string>>;
  saveEnv?: (env: Record<string, string>) => Promise<unknown>;
  queryKey?: unknown[];
  relatedKey?: unknown[];
  // Per-variable flags (build time / runtime / literal / multiline). Apps pass true; the database card does not.
  flagsEnabled?: boolean;
}) {
  const t = useT();
  const envId = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const envKey = queryKey ?? ["appEnv", id];
  const relKey = relatedKey ?? ["app", id];
  const confirm = useOptionalConfirm();
  const { data: env, isLoading, isError, refetch } = useQuery({ queryKey: envKey, queryFn: () => (fetchEnv ? fetchEnv() : api.getAppEnv(id)) });
  const flagsQ = useQuery({
    queryKey: ["appEnvFlags", id],
    queryFn: () => api.getAppEnvFlags(id),
    enabled: flagsEnabled,
    // 404 (an older hub without the endpoint) and 409 (unreadable stored flags) are answers, not blips: no retry.
    retry: (n, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 409)) && n < 1,
  });
  const flagsData = flagsEnabled ? flagsQ.data : undefined;
  // The editor never hard-depends on the flags endpoint: when it cannot answer, the card degrades to the plain
  // editor ("unavailable": saves WITHOUT a flags object, so the hub keeps whatever is stored) or, when the stored
  // blob is unreadable (409), offers an explicit reset ("corrupt": the one save that sends `flags: {}`).
  const flagsFailed = flagsEnabled && flagsQ.isError && !flagsData;
  const flagsCorrupt = flagsFailed && flagsQ.error instanceof ApiError && flagsQ.error.status === 409;
  const flagsUnavailable = flagsFailed && !flagsCorrupt;
  const flagsOn = flagsEnabled && !!flagsData; // per-row flag UI + the flags payload only exist when flags loaded
  const ctx = { applicable: flagsData?.applicable ?? { buildTime: false, literal: false } };
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState("");
  const [sorted, setSorted] = useState(false); // alphabetical VIEW toggle (never reorders the stored map)
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");

  // Reveal state: a global "reveal all" plus a per-row set, both cleared together by the auto-mask.
  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const remask = useCallback(() => { setRevealAll(false); setRevealed(new Set()); }, []);
  useAutoMask(revealAll || revealed.size > 0, remask);
  const isRevealed = (i: number) => revealAll || revealed.has(i);
  const toggleRow = (i: number) =>
    setRevealed((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  useEffect(() => {
    // Rows are replaced wholesale from the server, so any per-row reveal would now point at a
    // different row — re-mask to avoid showing a secret the user never revealed.
    // With flags enabled, wait for the flags query to SETTLE (loaded or failed): seeding rows before the flags
    // arrive and saving would send a present-but-empty `flags` that wipes every stored flag.
    if (env && (!flagsEnabled || flagsData || flagsFailed)) {
      // With the flags unavailable a value that holds a line break is shown as a multiline block (a single-line
      // <input> would flatten it on display and on save); nothing about it is sent.
      setRows(Object.entries(env).map(([key, value]) => newRow(key, value, canonicalFlags({ ...flagsData?.flags[key], ...(flagsFailed && hasLineBreak(value) ? { multiline: true } : {}) }))));
      remask();
    }
  }, [env, flagsData, flagsEnabled, flagsFailed, remask]);

  const save = useMutation({
    mutationFn: (opts?: { resetFlags?: boolean }) => {
      const map: Record<string, string> = {};
      for (const r of rows) if (r.key.trim()) map[r.key.trim()] = r.value;
      if (saveEnv) return saveEnv(map);
      // explicit flags object (empty unless a stored line-broken value must keep Multiline): the hub replaces the unreadable blob
      if (opts?.resetFlags) return api.setAppEnv(id, map, flagsPayload(rows));
      return flagsOn ? api.setAppEnv(id, map, flagsPayload(rows)) : api.setAppEnv(id, map);
    },
    onSuccess: () => {
      // Returned so isPending covers the refetch (the card doesn't flash dirty against a stale cache).
      return Promise.all([
        qc.invalidateQueries({ queryKey: envKey }),
        qc.invalidateQueries({ queryKey: relKey }),
        ...(flagsEnabled ? [qc.invalidateQueries({ queryKey: ["appEnvFlags", id] })] : []),
      ]);
    },
    meta: { successMessage: t("apps.saved") },
  });

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // Remove a row AND fix up the reveal set: drop index i and shift the ones above it down, so a
  // revealed row below the deleted one doesn't silently expose a different row's secret.
  const removeRow = (i: number) => {
    setRows((rs) => rs.filter((_, j) => j !== i));
    setRevealed((s) => {
      const n = new Set<number>();
      for (const idx of s) { if (idx < i) n.add(idx); else if (idx > i) n.add(idx - 1); }
      return n;
    });
  };
  const openBulk = () => { setBulkText(toDotenv(rows)); setBulk(true); };
  const applyBulk = () => {
    const parsed = parseDotenv(bulkText);
    if (parsed.some((r) => r.unterminated)) return; // the Apply button is disabled for this; never persist a swallowed file
    if (flagsOn || flagsFailed) {
      // Keep the flags a key already had; auto-enable Multiline for values with line breaks. (With the flags
      // unavailable the Multiline state only drives how a line-broken value is DISPLAYED: nothing is sent.)
      const { rows: next, autoCount } = applyBulkFlags(parsed, rows);
      setRows(next.map((r) => newRow(r.key, r.value, r.flags)));
      if (flagsOn && autoCount > 0) toast(t("apps.envMultilineAutoOn", { count: String(autoCount) }), "success");
    } else {
      setRows(parsed.map((r) => newRow(r.key, r.value)));
    }
    setBulk(false);
    remask();
  };
  const setFlags = (i: number, patch: Partial<EnvFlagView>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, flags: { ...r.flags, ...patch } } : r)));
  // Browsers strip line breaks when pasting into an <input>, so read the clipboard text ourselves and switch the
  // row to Multiline (keeping the full text) instead of silently flattening a PEM key.
  const onPasteValue = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    if (!flagsOn || !canWrite) return;
    const text = e.clipboardData.getData("text");
    if (!hasLineBreak(text)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const cur = rows[i]?.value ?? "";
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, value: cur.slice(0, start) + text + cur.slice(end), flags: { ...r.flags, multiline: true } } : r)));
    toast(t("apps.envMultilineAutoOn", { count: "1" }), "success");
  };
  const resetFlagsAndSave = async () => {
    const body = t("apps.envFlagsResetBody");
    const ok = confirm ? await confirm({ title: t("apps.envFlagsResetTitle"), body, danger: true }) : window.confirm(body);
    if (ok) save.mutate({ resetFlags: true });
  };
  const copyValue = async (value: string) => {
    const ok = await copyText(value);
    if (ok) toast(t("apps.envCopied"), "success");
    else toast(t("common.copyFailed"), "error");
  };

  const q = query.trim().toLowerCase();
  // Always show a blank-key row (e.g. one just added) so "Add variable" isn't swallowed by an active filter.
  const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || !r.key.trim() || r.key.toLowerCase().includes(q));
  // Optional alphabetical VIEW: sort a COPY by key (each item keeps its original index `i`, so edit/remove/
  // reveal still target the right stored row). Blank-key rows (being added) sort last so "Add variable" stays
  // reachable at the bottom. The stored map is untouched.
  const shownRows = sorted
    ? [...visible].sort((a, b) => {
        const ak = a.r.key.trim();
        const bk = b.r.key.trim();
        if (!ak || !bk) return ak ? -1 : bk ? 1 : 0;
        return ak.localeCompare(bk);
      })
    : visible;
  // Saving a map keeps only the last value for a duplicate key, so a collision silently drops data —
  // warn and block instead. Invalid names (the server rejects them) are a soft, non-blocking hint.
  const dups = duplicateKeys(rows);
  const dupSet = new Set(dups);
  const invalid = invalidKeys(rows);
  const invalidSet = new Set(invalid);
  // The server replaces the whole env blob on save, so Save must stay disabled until the env has loaded
  // (while loading/errored, rows is still [] and a click would PUT {} and wipe everything) and only
  // enable on a real change.
  const flagsLoaded = !flagsEnabled || !!flagsData || flagsFailed;
  const dirty = flagsLoaded && envDirty(rows, env, flagsOn ? flagsData?.flags : undefined);
  // Flag problems block Save (same pattern as duplicate keys); the server still has the final say.
  const issuesByRow = flagsOn ? rows.map((r) => rowIssues(r, ctx)) : rows.map(() => []);
  const budget = flagsOn ? budgetIssues(rows) : [];
  const flagBlocked = issuesByRow.some((x) => x.length > 0) || budget.length > 0;
  // Leave guard: the row edits, or a bulk-edit draft that hasn't been applied yet, are lost on navigation.
  // A save in flight is not "unsaved". Read-only viewers can't have edits.
  useUnsavedChanges(canWrite && !save.isPending && (dirty || (bulk && !!env && bulkText !== toDotenv(rows))));
  const keyCount = rows.filter((r) => r.key.trim()).length;
  // A live count so a bulk paste never silently replaces the whole env with nothing (count 0 = wipe).
  const bulkParsedRows = useMemo(() => (bulk ? parseDotenv(bulkText) : []), [bulk, bulkText]);
  const bulkCount = bulkParsedRows.filter((r) => r.key.trim()).length;
  // A quote that never closes would swallow the rest of the text into ONE value: show it, never persist it.
  const bulkUnterminated = bulkParsedRows.filter((r) => r.unterminated).map((r) => r.key);

  const toolbar = env ? (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {keyCount > 0 && <Badge>{keyCount}</Badge>}
      {canWrite && (
        <IconBtn label={bulk ? t("apps.rowEdit") : t("apps.bulkEdit")} pressed={bulk} onClick={() => (bulk ? setBulk(false) : openBulk())}>
          <FileText size={15} />
        </IconBtn>
      )}
      {!bulk && keyCount > 1 && (
        <IconBtn label={sorted ? t("apps.envUnsort") : t("apps.envSort")} pressed={sorted} onClick={() => setSorted((s) => !s)}>
          <ArrowDownAZ size={15} />
        </IconBtn>
      )}
      {!bulk && keyCount > 0 && (
        <IconBtn label={revealAll ? t("apps.hideValues") : t("apps.showValues")} pressed={revealAll} onClick={() => (revealAll ? remask() : setRevealAll(true))}>
          {revealAll ? <EyeOff size={15} /> : <Eye size={15} />}
        </IconBtn>
      )}
    </div>
  ) : undefined;

  return (
    <SectionCard title={title ?? t("apps.env")} desc={desc ?? t(clusterId ? "apps.envDescSwarm" : "apps.envDesc")} right={toolbar}>
      {isError && !env ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading || !env || !flagsLoaded ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}><Spinner /></div>
      ) : bulk ? (
        <>
          <textarea
            className="mono"
            style={{ ...envField, width: "100%", minHeight: 180, resize: "vertical" }}
            placeholder={t("apps.bulkPlaceholder")}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            aria-label={t("apps.bulkEdit")}
            spellCheck={false}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <span role="status" aria-live="polite" style={{ fontSize: 12, color: bulkCount === 0 ? "var(--c-am)" : "var(--c-tx3)" }}>
              {bulkCount === 0 ? t("apps.bulkParsedEmpty") : t("apps.bulkParsed", { count: String(bulkCount) })}
            </span>
            <div style={{ flex: 1 }} />
            <Btn variant="ghost" onClick={() => setBulk(false)}>{t("common.cancel")}</Btn>
            <Btn icon={Check} onClick={applyBulk} disabled={bulkCount === 0 || bulkUnterminated.length > 0}>{t("apps.bulkApply")}</Btn>
          </div>
          {bulkUnterminated.length > 0 && (
            <div role="alert" data-testid="env-bulk-unterminated" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>
              <AlertCircle size={13} aria-hidden style={{ flexShrink: 0 }} />
              <span>{t("apps.bulkUnterminated", { keys: bulkUnterminated.join(", ") })}</span>
            </div>
          )}
        </>
      ) : (
        <>
          {flagsUnavailable && (
            <div role="status" data-testid="env-flags-unavailable" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--c-am)", marginBottom: 8 }}>
              <AlertTriangle size={13} aria-hidden style={{ flexShrink: 0 }} />
              <span>{t("apps.envFlagsUnavailable")}</span>
              <Btn variant="ghost" onClick={() => flagsQ.refetch()}>{t("apps.envFlagsRetry")}</Btn>
            </div>
          )}
          {flagsCorrupt && (
            <div role="alert" data-testid="env-flags-corrupt" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--c-am)", marginBottom: 8 }}>
              <AlertTriangle size={13} aria-hidden style={{ flexShrink: 0 }} />
              <span>{t("apps.envFlagsCorrupt")}</span>
            </div>
          )}
          {rows.length > 3 && (
            <input
              style={{ ...envField, width: "100%", marginBottom: 8, fontFamily: "inherit" }}
              placeholder={t("apps.searchKeys")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("apps.searchKeys")}
            />
          )}
          {rows.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--c-tx3)", padding: "6px 0 2px" }}>{t("apps.envEmpty")}</div>
          ) : visible.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--c-tx3)", padding: "6px 0 2px" }}>{t("apps.envNoMatch", { query: query.trim() })}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {shownRows.map(({ r, i }) => {
                const isDup = !!r.key.trim() && dupSet.has(r.key.trim());
                const shown = isRevealed(i);
                const trimmed = r.key.trim();
                // Per-row problem, surfaced inline. Same rules as before (dup blocks save, invalid is a soft
                // hint); a value with no key is dropped on save, so flag it too (soft, not blocking).
                const problem = isDup
                  ? { level: "error" as const, msg: t("apps.envRowDup", { key: trimmed }) }
                  : trimmed && invalidSet.has(trimmed)
                    ? { level: "warn" as const, msg: t("apps.envRowInvalid") }
                    : !trimmed && r.value !== ""
                      ? { level: "warn" as const, msg: t("apps.envRowKeyRequired") }
                      : null;
                const problemId = `env-row-${envId}-${i}-msg`;
                return (
                  <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      style={{ ...envField, flex: "1 1 160px", ...(isDup ? { borderColor: "var(--c-r)" } : problem ? { borderColor: "var(--c-am)" } : {}) }}
                      placeholder={t("apps.envKey")}
                      aria-label={t("apps.envKey")}
                      value={r.key}
                      onChange={(e) => setRow(i, { key: e.target.value })}
                      readOnly={!canWrite}
                      aria-required={canWrite || undefined}
                      aria-invalid={!!problem}
                      aria-describedby={problem ? problemId : undefined}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    {r.flags.multiline ? (
                      shown ? (
                        <textarea
                          className="mono"
                          style={{ ...envField, flex: "2 1 200px", resize: "vertical" }}
                          rows={Math.min(8, lineCount(r.value) + 1)}
                          placeholder={t("apps.envValue")}
                          aria-label={t("apps.envValue")}
                          value={r.value}
                          onChange={(e) => setRow(i, { value: e.target.value })}
                          readOnly={!canWrite}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      ) : (
                        <div data-testid="env-ml-masked" className="mono" style={{ ...envField, flex: "2 1 200px", color: "var(--c-tx3)", userSelect: "none" }}>
                          {"\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022  "}({t("apps.envMultilineLines", { count: String(lineCount(r.value)) })})
                        </div>
                      )
                    ) : (
                      <input
                        style={{ ...envField, flex: "2 1 200px" }}
                        type={shown ? "text" : "password"}
                        placeholder={t("apps.envValue")}
                        aria-label={t("apps.envValue")}
                        value={r.value}
                        onChange={(e) => setRow(i, { value: e.target.value })}
                        onPaste={flagsOn ? (e) => onPasteValue(i, e) : undefined}
                        readOnly={!canWrite}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    )}
                    {flagsOn && (
                      <button
                        type="button"
                        className="tg-iconbtn"
                        aria-label={t("apps.envOptions")}
                        title={t("apps.envOptions")}
                        aria-expanded={r.optsOpen}
                        onClick={() => setRow(i, { optsOpen: !r.optsOpen })}
                        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 6, borderRadius: "var(--r1)", fontFamily: "inherit", lineHeight: 1 }}
                      >
                        <SlidersHorizontal size={14} />
                      </button>
                    )}
                    <IconBtn label={shown ? t("apps.envHideValue") : t("apps.envRevealValue")} pressed={shown} onClick={() => toggleRow(i)}>
                      {shown ? <EyeOff size={14} /> : <Eye size={14} />}
                    </IconBtn>
                    <IconBtn label={t("apps.envCopy")} onClick={() => copyValue(r.value)}>
                      <Copy size={14} />
                    </IconBtn>
                    {canWrite && (
                      <IconBtn label={t("common.remove")} danger onClick={() => removeRow(i)}>
                        <X size={14} />
                      </IconBtn>
                    )}
                    {flagsOn && (r.flags.buildTime || r.flags.literal || r.flags.multiline) && (
                      <div data-testid="env-row-chips" style={{ flexBasis: "100%", display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {r.flags.buildTime && <Badge>{r.flags.runtime ? t("apps.envChipBuild") : t("apps.envChipBuildOnly")}</Badge>}
                        {r.flags.literal && <Badge>{t("apps.envChipLiteral")}</Badge>}
                        {r.flags.multiline && <Badge>{t("apps.envChipMultiline")}</Badge>}
                      </div>
                    )}
                    {flagsOn && r.optsOpen && (
                      <div data-testid="env-row-options" style={{ flexBasis: "100%", display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}>
                        {ctx.applicable.buildTime && (
                          <FlagOption label={t("apps.envFlagBuild")} hint={t("apps.envFlagBuildHint")} checked={r.flags.buildTime} disabled={!canWrite} onChange={(v) => setFlags(i, v ? { buildTime: true } : { buildTime: false, runtime: true })} />
                        )}
                        {ctx.applicable.buildTime && r.flags.buildTime && (
                          <FlagOption label={t("apps.envFlagRuntime")} hint={t("apps.envFlagRuntimeHint")} checked={r.flags.runtime} disabled={!canWrite} onChange={(v) => setFlags(i, { runtime: v })} />
                        )}
                        {ctx.applicable.buildTime && r.flags.buildTime && looksSensitiveKey(trimmed) && (
                          <div style={{ fontSize: 12, color: "var(--c-am)" }}>{t("apps.envBuildSensitiveWarn")}</div>
                        )}
                        {ctx.applicable.literal ? (
                          <FlagOption label={t("apps.envFlagLiteral")} hint={t("apps.envFlagLiteralHint")} checked={r.flags.literal} disabled={!canWrite} onChange={(v) => setFlags(i, { literal: v })} />
                        ) : (
                          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.envFlagLiteralInert")}</div>
                        )}
                        <FlagOption label={t("apps.envFlagMultiline")} hint={t("apps.envFlagMultilineHint")} checked={r.flags.multiline} disabled={!canWrite} onChange={(v) => setFlags(i, { multiline: v })} />
                      </div>
                    )}
                    {flagsOn &&
                      issuesByRow[i].map((iss) => (
                        <div key={iss.code} data-testid="env-row-flag-issue" role="alert" style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--c-r)", flexWrap: "wrap" }}>
                          <AlertCircle size={13} aria-hidden style={{ flexShrink: 0 }} />
                          <span>{t(`apps.${iss.i18nKey}`, iss.params)}</span>
                          {iss.code === "newline" && canWrite && (
                            <Btn variant="ghost" onClick={() => setFlags(i, { multiline: true })}>{t("apps.envRowNewlineFix")}</Btn>
                          )}
                        </div>
                      ))}
                    {problem && (
                      <div
                        id={problemId}
                        data-testid="env-row-problem"
                        style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: problem.level === "error" ? "var(--c-r)" : "var(--c-am)" }}
                      >
                        {problem.level === "error" ? <AlertCircle size={13} aria-hidden style={{ flexShrink: 0 }} /> : <AlertTriangle size={13} aria-hidden style={{ flexShrink: 0 }} />}
                        <span>{problem.msg}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {dups.length > 0 && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("apps.envDupWarning", { keys: dups.join(", ") })}</div>}
          {invalid.length > 0 && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envInvalidWarning", { keys: invalid.join(", ") })}</div>}
          {budget.map((b) => <div key={b.i18nKey} role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t(`apps.${b.i18nKey}`, b.params)}</div>)}
          {save.isError && (
            <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>
              {flagsEnabled && save.error instanceof ApiError && (save.error.status === 400 || save.error.status === 409) && save.error.message
                ? t("apps.envSaveFailedDetail", { detail: save.error.message })
                : t("apps.envSaveFailed")}
            </div>
          )}
          {canWrite && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
              <Btn variant="ghost" icon={Plus} onClick={() => setRows((rs) => [...rs, newRow()])}>{t("apps.envAdd")}</Btn>
              {dirty && !save.isPending && <span style={{ fontSize: 12, color: "var(--c-am)" }}>{t("apps.envUnsaved")}</span>}
              <div style={{ flex: 1 }} />
              {flagsCorrupt ? (
                // A plain save would 409 again (the hub cannot merge into an unreadable blob), so the only save here
                // is the explicit reset: it sends `flags: {}` and replaces the corrupt blob.
                <Btn variant="danger" onClick={resetFlagsAndSave} disabled={save.isPending || dups.length > 0}>
                  {save.isPending ? t("apps.envSaving") : t("apps.envFlagsReset")}
                </Btn>
              ) : (
                <Btn onClick={() => save.mutate(undefined)} disabled={save.isPending || !dirty || dups.length > 0 || flagBlocked}>
                  {save.isPending ? t("apps.envSaving") : t("apps.save")}
                </Btn>
              )}
            </div>
          )}
          {save.isSuccess && <div role="status" style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{redeployHint ?? t("apps.envRedeploy")}</div>}
        </>
      )}
    </SectionCard>
  );
}

/** One labelled checkbox with its hint under it (inline panel row, mobile-first). The hint is the description, not
 *  part of the accessible NAME. */
function FlagOption({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const hintId = useId();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12, color: "var(--c-tx)" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={checked} disabled={disabled} aria-describedby={hintId} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      <span id={hintId} style={{ color: "var(--c-tx3)", paddingLeft: 24 }}>{hint}</span>
    </div>
  );
}
