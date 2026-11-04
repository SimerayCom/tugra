"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ArrowDownAZ, Check, Copy, Eye, EyeOff, FileText, Plus, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { copyText } from "../lib/clipboard";
import { useAutoMask } from "../lib/use-auto-mask";
import { parseDotenv, toDotenv, duplicateKeys, invalidKeys, envDirty } from "../lib/dotenv";
import { Badge, Btn, SectionCard, Spinner } from "./ui";
import { ErrorState } from "./error-state";
import { IconBtn } from "./icon-btn";
import { useToast } from "./toast";

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

type Row = { key: string; value: string };

/**
 * Edit an app's environment variables. Values are masked by default and auto-re-mask (30s / tab
 * hidden); the server replaces the whole blob on save, so Save stays disabled until the env has
 * loaded and actually changed, and a duplicate key blocks the save (a map would silently drop one).
 * Read-only viewers can reveal and copy but see no editing controls or Save.
 */
export function EnvCard({ id, clusterId, canWrite }: { id: string; clusterId?: string | null; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: env, isLoading, isError, refetch } = useQuery({ queryKey: ["appEnv", id], queryFn: () => api.getAppEnv(id) });
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
    if (env) { setRows(Object.entries(env).map(([key, value]) => ({ key, value }))); remask(); }
  }, [env, remask]);

  const save = useMutation({
    mutationFn: () => {
      const map: Record<string, string> = {};
      for (const r of rows) if (r.key.trim()) map[r.key.trim()] = r.value;
      return api.setAppEnv(id, map);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appEnv", id] });
      qc.invalidateQueries({ queryKey: ["app", id] });
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
  const applyBulk = () => { setRows(parseDotenv(bulkText)); setBulk(false); remask(); };
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
  // The server replaces the whole env blob on save, so Save must stay disabled until the env has loaded
  // (while loading/errored, rows is still [] and a click would PUT {} and wipe everything) and only
  // enable on a real change.
  const dirty = envDirty(rows, env);
  const keyCount = rows.filter((r) => r.key.trim()).length;
  // A live count so a bulk paste never silently replaces the whole env with nothing (count 0 = wipe).
  const bulkCount = useMemo(() => (bulk ? parseDotenv(bulkText).filter((r) => r.key.trim()).length : 0), [bulk, bulkText]);

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
    <SectionCard title={t("apps.env")} desc={t(clusterId ? "apps.envDescSwarm" : "apps.envDesc")} right={toolbar}>
      {isError && !env ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading || !env ? (
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
            <Btn icon={Check} onClick={applyBulk} disabled={bulkCount === 0}>{t("apps.bulkApply")}</Btn>
          </div>
        </>
      ) : (
        <>
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
                return (
                  <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      style={{ ...envField, flex: "1 1 160px", ...(isDup ? { borderColor: "var(--c-r)" } : {}) }}
                      placeholder={t("apps.envKey")}
                      aria-label={t("apps.envKey")}
                      value={r.key}
                      onChange={(e) => setRow(i, { key: e.target.value })}
                      readOnly={!canWrite}
                      aria-invalid={isDup}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <input
                      style={{ ...envField, flex: "2 1 200px" }}
                      type={shown ? "text" : "password"}
                      placeholder={t("apps.envValue")}
                      aria-label={t("apps.envValue")}
                      value={r.value}
                      onChange={(e) => setRow(i, { value: e.target.value })}
                      readOnly={!canWrite}
                      spellCheck={false}
                      autoComplete="off"
                    />
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
                  </div>
                );
              })}
            </div>
          )}
          {dups.length > 0 && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("apps.envDupWarning", { keys: dups.join(", ") })}</div>}
          {invalid.length > 0 && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envInvalidWarning", { keys: invalid.join(", ") })}</div>}
          {save.isError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("apps.envSaveFailed")}</div>}
          {canWrite && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
              <Btn variant="ghost" icon={Plus} onClick={() => setRows((rs) => [...rs, { key: "", value: "" }])}>{t("apps.envAdd")}</Btn>
              {dirty && !save.isPending && <span style={{ fontSize: 12, color: "var(--c-am)" }}>{t("apps.envUnsaved")}</span>}
              <div style={{ flex: 1 }} />
              <Btn onClick={() => save.mutate()} disabled={save.isPending || !dirty || dups.length > 0}>
                {save.isPending ? t("apps.envSaving") : t("apps.save")}
              </Btn>
            </div>
          )}
          {save.isSuccess && <div role="status" style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
        </>
      )}
    </SectionCard>
  );
}
