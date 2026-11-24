"use client";

import { CheckSquare, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { ImportBulkBar } from "./import-bulk-bar";
import { ImportMappingRow } from "./import-mapping-row";
import { conflictsFor, groupRows, mappableItems, type BulkOp, type BulkRow, type ItemField } from "../lib/import-mapping";
import type { ImportMappingDoc, ImportPlan, ImportResolved } from "../lib/types";

export type ReviewFilter = "all" | "changed" | "conflicts" | "excluded";
const PAGE = 100;

const input: React.CSSProperties = { width: "100%", minHeight: 44, padding: "8px 10px", fontSize: 14, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontFamily: "inherit", boxSizing: "border-box" };

/** The grouped, filterable list of mapping rows. Groups are the effective target project ("Ungrouped" when none);
 *  a group header re-targets the whole group and opens the bulk menu. Above 100 rows it renders in pages. */
export function ImportMappingTable({
  plan,
  doc,
  resolved,
  search,
  filter,
  onEdit,
  onResetItem,
  onBulk,
  onMoveGroup,
}: {
  plan: ImportPlan;
  doc: ImportMappingDoc;
  resolved: ImportResolved | null;
  search: string;
  filter: ReviewFilter;
  onEdit: (itemRef: string, field: ItemField, value: string | boolean | null | undefined, sourceName: string) => void;
  onResetItem: (itemRef: string) => void;
  onBulk: (rows: BulkRow[], op: BulkOp) => void;
  onMoveGroup: (rows: BulkRow[], project: string) => void;
}) {
  const t = useT();
  const [limit, setLimit] = useState(PAGE);
  const effByRef = useMemo(() => new Map((resolved?.effective ?? []).map((e) => [e.itemRef, e])), [resolved]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mappableItems(plan)
      .map((item) => {
        const eff = effByRef.get(item.itemRef);
        return { item, eff, entry: doc.items[item.itemRef], conflicts: conflictsFor(resolved, item.itemRef), project: eff?.project ?? null };
      })
      .filter((r) => {
        if (q && !(r.item.name.toLowerCase().includes(q) || (r.entry?.name ?? "").toLowerCase().includes(q) || r.item.itemRef.toLowerCase().includes(q))) return false;
        if (filter === "changed") return !!r.entry && Object.keys(r.entry).length > 0;
        if (filter === "conflicts") return r.conflicts.length > 0;
        if (filter === "excluded") return r.entry?.include === false;
        return true;
      });
  }, [plan, doc, resolved, effByRef, search, filter]);

  if (rows.length === 0) return <div style={{ fontSize: 12, color: "var(--c-tx3)", padding: "12px 0" }}>{t("import.review.empty")}</div>;

  const toBulk = (rs: typeof rows): BulkRow[] => rs.map((r) => ({ itemRef: r.item.itemRef, sourceName: r.item.name, name: r.entry?.name ?? r.item.name, environment: r.eff?.environment ?? null }));
  const groups = groupRows(rows);
  let shown = 0;
  const allIncluded = rows.every((r) => r.entry?.include !== false);
  const noneIncluded = rows.every((r) => r.entry?.include === false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* One click to keep or drop everything listed (the current search/filter), then pick per project below. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn variant="ghost" icon={CheckSquare} disabled={allIncluded} onClick={() => onBulk(toBulk(rows), { type: "include" })}>{t("import.review.includeAll")}</Btn>
        <Btn variant="ghost" icon={Square} disabled={noneIncluded} onClick={() => onBulk(toBulk(rows), { type: "exclude" })}>{t("import.review.excludeAll")}</Btn>
      </div>
      <datalist id="imp-projects">
        {(resolved?.projects ?? []).map((p) => (
          <option key={p.name} value={p.name} />
        ))}
      </datalist>
      <datalist id="imp-environments">
        {[...new Set((resolved?.projects ?? []).flatMap((p) => p.environments))].map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>
      {groups.map((g, gi) => {
        const room = Math.max(0, limit - shown);
        const slice = g.rows.slice(0, room);
        shown += slice.length;
        if (slice.length === 0) return null;
        const label = g.project || t("import.review.ungrouped");
        return (
          <section key={`${g.project}-${gi}`} aria-label={t("import.review.groupFor", { project: label })}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13, flex: "1 1 160px" }}>
                {label} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>({g.rows.length})</span>
              </div>
              <div style={{ flex: "1 1 200px", maxWidth: 280 }}>
                <label htmlFor={`imp-group-${gi}`} style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", marginBottom: 2 }}>{t("import.review.groupProject")}</label>
                <GroupProjectInput id={`imp-group-${gi}`} value={g.project} placeholder={t("import.review.createNew")} onCommit={(v) => v.trim() && v.trim() !== g.project && onMoveGroup(toBulk(g.rows), v)} />
              </div>
              {g.rows.every((r) => r.entry?.include === false) ? (
                <Btn variant="ghost" icon={CheckSquare} onClick={() => onBulk(toBulk(g.rows), { type: "include" })}>{t("import.review.includeGroup")}</Btn>
              ) : (
                <Btn variant="ghost" icon={Square} onClick={() => onBulk(toBulk(g.rows), { type: "exclude" })}>{t("import.review.excludeGroup")}</Btn>
              )}
              <ImportBulkBar count={g.rows.length} onApply={(op) => onBulk(toBulk(g.rows), op)} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {slice.map((r) => (
                <ImportMappingRow
                  key={r.item.itemRef}
                  rowKey={`imp-row-${r.item.itemRef.replace(/[^A-Za-z0-9_-]/g, "_")}`}
                  item={r.item}
                  eff={r.eff}
                  entry={r.entry}
                  conflicts={r.conflicts}
                  onEdit={(field, value) => onEdit(r.item.itemRef, field, value, r.item.name)}
                  onReset={() => onResetItem(r.item.itemRef)}
                />
              ))}
            </div>
          </section>
        );
      })}
      {rows.length > limit && (
        <div>
          <Btn variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>{t("import.review.showMore", { count: rows.length - limit })}</Btn>
        </div>
      )}
    </div>
  );
}

/** The editable group header: commits on Enter/blur, Esc reverts. */
function GroupProjectInput({ id, value, placeholder, onCommit }: { id: string; value: string; placeholder: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <input
      id={id}
      style={input}
      value={draft}
      placeholder={placeholder}
      list="imp-projects"
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}
