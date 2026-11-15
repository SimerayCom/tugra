"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Save, Undo2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { SectionCard, Btn, Spinner } from "./ui";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";
import { ImportMappingTable, type ReviewFilter } from "./import-mapping-table";
import { ImportBulkBar } from "./import-bulk-bar";
import { ImportConflictsPanel } from "./import-conflicts-panel";
import { ImportMappingIo } from "./import-mapping-io";
import {
  applyBulk,
  buildTemplate,
  canApply,
  emptyDoc,
  initMappingState,
  mappableItems,
  mappingReducer,
  moveRows,
  removeOrphans,
  resetAll,
  resetItem,
  reviewCounts,
  setAck,
  setItemField,
} from "../lib/import-mapping";
import type { ImportMappingDoc, ImportPlan, ImportRemoteKind, ImportResolved, Team } from "../lib/types";

const label: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" };
const field: React.CSSProperties = { width: "100%", minHeight: 44, padding: "8px 10px", fontSize: 14, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontFamily: "inherit", boxSizing: "border-box" };
const FILTERS: ReviewFilter[] = ["all", "changed", "conflicts", "excluded"];

interface ResolveState {
  resolved: ImportResolved | null;
  key: string | null;
  pending: boolean;
  error: string | null;
}

/** The "Review & rename" step: edit names and placement, see conflicts against the target, then apply. The hub's
 *  resolve is authoritative and bound to a mappingHash; Apply is only enabled on a fresh, error-free, fully
 *  acknowledged resolve. Everything here changes names and placement only. */
export function ImportReviewStep({
  plan,
  kind,
  sessionId,
  servers,
  teams,
  onApplied,
  onBack,
}: {
  plan: ImportPlan;
  kind: ImportRemoteKind;
  sessionId: string;
  servers: Array<{ id: string; name: string; teamId: string }>;
  teams: Team[];
  onApplied: (opId: string) => void;
  onBack: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const scopeKey = plan.mapping?.scopeKey ?? "";
  const scope = useMemo(() => ({ sourceKind: kind, ...(scopeKey ? { scopeKey } : {}) }), [kind, scopeKey]);

  const [state, dispatch] = useReducer(mappingReducer, undefined, () => initMappingState(plan.mapping?.stored ? { ...plan.mapping.stored, scope } : emptyDoc(scope)));
  const doc = state.doc;
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [reconcile, setReconcile] = useState(false);
  const [ignoreSaved, setIgnoreSaved] = useState(false);
  const [storedVersion, setStoredVersion] = useState<number | null>(plan.mapping?.storedVersion ?? null);
  const [bannerShown, setBannerShown] = useState(!!plan.mapping?.stored);
  const [nonce, setNonce] = useState(0);
  const [rs, setRs] = useState<ResolveState>({ resolved: null, key: null, pending: false, error: null });
  const first = useRef(true);

  const template = useMemo(() => buildTemplate(plan, scope), [plan, scope]);
  const items = useMemo(() => mappableItems(plan), [plan]);
  const nameOf = (ref: string) => items.find((i) => i.itemRef === ref)?.name ?? ref;
  const target = servers.find((s) => s.id === serverId);
  const targetTeam = teams.find((x) => x.id === target?.teamId)?.name ?? target?.teamId ?? "";

  const { data: stored } = useQuery({ queryKey: ["import-mapping", sessionId], queryFn: () => api.importMappingGet(sessionId), enabled: bannerShown });

  // Debounced, authoritative resolve (instant on entry). A stale response is dropped via `cancelled`.
  const docKey = useMemo(() => JSON.stringify([doc, serverId, reconcile, nonce]), [doc, serverId, reconcile, nonce]);
  useEffect(() => {
    if (!serverId || ignoreSaved) return;
    let cancelled = false;
    setRs((s) => ({ ...s, pending: true, error: null }));
    const handle = setTimeout(
      () => {
        api
          .importResolve({ sessionId, sourceKind: kind, planHash: plan.planHash, targetServerId: serverId, reconcile, mapping: doc })
          .then((r) => !cancelled && setRs({ resolved: r, key: docKey, pending: false, error: null }))
          .catch((e) => !cancelled && setRs((s) => ({ ...s, pending: false, error: (e as Error).message })));
      },
      first.current ? 0 : 800,
    );
    first.current = false;
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // docKey covers doc/serverId/reconcile/nonce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, ignoreSaved]);

  const resolved = rs.resolved;
  const counts = reviewCounts(resolved);
  const fresh = rs.key === docKey && !rs.pending;
  const gateOk = ignoreSaved ? !!serverId : canApply({ fresh, inFlight: rs.pending, hasTarget: !!serverId, resolved });
  const driftCount = resolved?.effective.filter((e) => e.status === "already_imported" && e.drift?.length).length ?? 0;

  const edit = (next: ImportMappingDoc) => dispatch({ type: "edit", doc: next });

  const save = useMutation({
    mutationFn: () => api.importMappingPut(sessionId, { mapping: doc, ...(storedVersion ? { expectedVersion: storedVersion } : {}) }),
    onSuccess: (r) => {
      setStoredVersion(r.version);
      toast(t("import.review.profileSaved", { version: r.version }), "success");
      void qc.invalidateQueries({ queryKey: ["import-mapping", sessionId] });
    },
    onError: (e) => toast(errText(e, t), "error"),
  });
  const discard = useMutation({
    mutationFn: () => api.importMappingDelete(sessionId),
    onSuccess: () => {
      setBannerShown(false);
      setStoredVersion(null);
      edit(emptyDoc(scope));
    },
    onError: (e) => toast(errText(e, t), "error"),
  });

  const apply = useMutation({
    mutationFn: () =>
      ignoreSaved
        ? api.importApply({ sourceKind: kind, sessionId, targetServerId: serverId, planHash: plan.planHash, ignoreStoredMapping: true })
        : api.importApply({ sourceKind: kind, sessionId, targetServerId: serverId, planHash: plan.planHash, mapping: doc, mappingHash: resolved!.mappingHash, ...(reconcile ? { reconcile: true } : {}) }),
    onSuccess: (r) => {
      // The hub echoes whether it applied the mapping; an old hub that ignored it must not pass silently.
      if (!ignoreSaved && r.mappingApplied !== true) toast(t("import.review.notApplied"), "error");
      onApplied(r.opId);
    },
    onError: (e) => {
      toast(errText(e, t), "error");
      if ((e as { code?: string }).code === "import.mapping_changed") setNonce((n) => n + 1); // re-resolve against the new state
    },
  });

  const onApply = async () => {
    const body = ignoreSaved
      ? t("import.review.confirmBodyLegacy")
      : t("import.review.confirmBody", { renamed: counts.renamed, moved: counts.moved, excluded: counts.excluded, aliased: counts.aliased, projects: counts.newProjects, environments: counts.newEnvironments });
    const ok = await confirm({ title: t("import.review.confirmTitle"), body });
    if (ok) apply.mutate();
  };

  const focusItem = (ref: string) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-itemref]")).find((n) => n.getAttribute("data-itemref") === ref);
    el?.scrollIntoView?.({ block: "center" });
    el?.focus();
  };

  // Servers grouped by their team (the target team is derived from the chosen server — read-only).
  const byTeam = useMemo(() => {
    const m = new Map<string, typeof servers>();
    for (const s of servers) m.set(s.teamId, [...(m.get(s.teamId) ?? []), s]);
    return [...m.entries()];
  }, [servers]);

  const applyLabel = ignoreSaved ? t("import.review.apply") : t("import.review.applyCounts", { apps: counts.apps, databases: counts.databases, excluded: counts.excluded });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 960 }}>
      <SectionCard
        title={t("import.review.title")}
        desc={t("import.review.subtitle")}
        right={<Btn variant="ghost" onClick={onBack}>{t("import.review.back")}</Btn>}
        style={{ padding: 20, marginBottom: 0 }}
      >
        {bannerShown && (
          <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
            <span style={{ flex: 1, minWidth: 200 }}>
              {stored?.lastAppliedAt
                ? t("import.review.profileLoaded", { version: storedVersion ?? stored.version ?? 1, date: new Date(stored.lastAppliedAt).toLocaleString() })
                : t("import.review.profileLoadedNever", { version: storedVersion ?? 1 })}
            </span>
            <Btn variant="ghost" onClick={() => discard.mutate()} disabled={discard.isPending}>{t("import.review.profileDiscard")}</Btn>
            <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32, cursor: "pointer" }}>
              <input type="checkbox" checked={ignoreSaved} onChange={(e) => setIgnoreSaved(e.target.checked)} />
              {t("import.review.ignoreSaved")}
            </label>
          </div>
        )}

        <label style={label} htmlFor="imp-review-target">{t("import.review.targetServer")}</label>
        {servers.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 8px" }}>{t("import.review.noTarget")}</p>
        ) : (
          <select id="imp-review-target" style={{ ...field, maxWidth: 360 }} value={serverId} onChange={(e) => setServerId(e.target.value)}>
            {byTeam.map(([tid, list]) => (
              <optgroup key={tid} label={teams.find((x) => x.id === tid)?.name ?? tid}>
                {list.map((sv) => (
                  <option key={sv.id} value={sv.id}>{sv.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        {target && <p style={{ fontSize: 12, margin: "6px 0 0" }}>{t("import.review.targetTeam", { team: targetTeam })}</p>}
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 14px" }}>{t("import.review.targetTeamHint")}</p>

        {ignoreSaved ? (
          <p style={{ fontSize: 12, color: "var(--c-am)" }}>{t("import.review.confirmBodyLegacy")}</p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
              <div style={{ flex: "1 1 200px", minWidth: 160 }}>
                <label htmlFor="imp-review-search" style={label}>{t("import.review.searchLabel")}</label>
                <input id="imp-review-search" type="search" style={{ ...field }} value={search} placeholder={t("import.review.search")} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
              </div>
              <div role="radiogroup" aria-label={t("import.review.filter.label")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {FILTERS.map((f) => (
                  <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, minHeight: 44, padding: "6px 12px", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", cursor: "pointer", background: filter === f ? "var(--c-a)" : "var(--c-el)", color: filter === f ? "var(--c-on-a)" : "var(--c-tx)" }}>
                    {t(`import.review.filter.${f}`)}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <Btn variant="ghost" icon={Undo2} onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0}>{t("import.review.undo")}</Btn>
              <Btn variant="ghost" onClick={() => edit(resetAll(doc))} disabled={Object.keys(doc.items).length === 0 && doc.acks.length === 0}>{t("import.review.resetAll")}</Btn>
              <ImportBulkBar
                count={items.length}
                label={t("import.review.bulk.title")}
                onApply={(op) =>
                  edit(applyBulk(doc, items.map((i) => ({ itemRef: i.itemRef, sourceName: i.name, name: doc.items[i.itemRef]?.name ?? i.name, environment: resolved?.effective.find((e) => e.itemRef === i.itemRef)?.environment ?? null })), op))
                }
              />
              <Btn variant="ghost" icon={Save} onClick={() => save.mutate()} disabled={save.isPending}>{t("import.review.saveProfile")}</Btn>
            </div>
            <ImportMappingIo doc={doc} template={template} kind={kind} scopeKey={scopeKey} onLoad={(d) => edit({ ...d, scope })} />

            <div aria-live="polite" style={{ fontSize: 12, color: "var(--c-tx3)", margin: "12px 0" }}>
              {rs.pending ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Spinner /> {t("import.review.recomputing")}</span>
              ) : (
                t("import.review.live", { apps: counts.apps, databases: counts.databases, renamed: counts.renamed, moved: counts.moved, excluded: counts.excluded, errors: counts.errors, warnings: counts.warnings })
              )}
            </div>
            {rs.error && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginBottom: 8 }}>{t("import.review.resolveFailed", { message: rs.error })}</div>}

            <div style={{ fontSize: 11, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 }}>
              <span>{t("import.review.hint.rename")}</span>
              <span>{t("import.review.hint.envRemap")}</span>
              <span>{t("import.review.hint.alias")}</span>
              <span>{t("import.review.hint.database")}</span>
            </div>

            <ImportMappingTable
              plan={plan}
              doc={doc}
              resolved={resolved}
              search={search}
              filter={filter}
              onEdit={(ref, f, v, src) => edit(setItemField(doc, ref, f, v, src))}
              onResetItem={(ref) => edit(resetItem(doc, ref))}
              onBulk={(rows, op) => edit(applyBulk(doc, rows, op))}
              onMoveGroup={(rows, project) => edit(moveRows(doc, rows, project))}
            />

            <div style={{ marginTop: 16 }}>
              <ImportConflictsPanel
                resolved={resolved}
                nameOf={nameOf}
                onAck={(k, on) => edit(setAck(doc, k, on))}
                onFocusItem={focusItem}
                onRemoveOrphan={(ref) => edit(removeOrphans(doc, [ref]))}
                onRemoveAllOrphans={() => edit(removeOrphans(doc, resolved?.orphans ?? []))}
              />
            </div>

            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "14px 0 0", cursor: "pointer", minHeight: 32 }}>
              <input type="checkbox" checked={reconcile} onChange={(e) => setReconcile(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                <span style={{ fontSize: 13 }}>{t("import.review.reconcile")}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t("import.review.reconcileHelp")}</span>
                {driftCount > 0 && <span style={{ display: "block", fontSize: 11, color: "var(--c-am)" }}>{t("import.review.reconcileNote", { count: driftCount })}</span>}
              </span>
            </label>
            <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "12px 0 0" }}>{t("import.review.hint.treeKept")}</p>
          </>
        )}

        <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Btn onClick={onApply} disabled={!gateOk || apply.isPending} style={{ minHeight: 44 }}>
            {apply.isPending ? t("import.review.applying") : applyLabel}
          </Btn>
          {!gateOk && !ignoreSaved && !rs.pending && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("import.review.applyBlocked")}</span>}
        </div>
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "10px 0 0" }}>{t("import.review.hint.scopeOnly")}</p>
      </SectionCard>
    </div>
  );
}

/** A user-facing message for a failed call: the hub's mapping codes get a fixed translation, anything else its message. */
function errText(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): string {
  const code = (e as { code?: string }).code;
  if (code && /^import\.mapping_/.test(code)) return t(`import.review.err.${code.slice("import.".length)}`);
  return (e as Error).message;
}
