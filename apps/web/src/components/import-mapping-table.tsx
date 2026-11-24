"use client";

import { CheckSquare, GripVertical, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { ImportBulkBar } from "./import-bulk-bar";
import { ImportMappingRow } from "./import-mapping-row";
import { ProjectPicker, type ProjectChoice } from "./project-picker";
import { conflictsFor, dropProject, groupRows, mappableItems, type BulkOp, type BulkRow, type ItemField } from "../lib/import-mapping";
import type { ImportMappingDoc, ImportPlan, ImportResolved } from "../lib/types";

export type ReviewFilter = "all" | "changed" | "conflicts" | "excluded";
const PAGE = 100;

/** The grouped, filterable list of mapping rows. Groups are the effective target project ("Ungrouped" when none);
 *  a group header re-targets the whole group and opens the bulk menu. Above 100 rows it renders in pages. */
export function ImportMappingTable({
  plan,
  doc,
  resolved,
  search,
  filter,
  projects,
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
  /** What the project pickers offer (the target team's projects plus the ones this import will create). */
  projects: ProjectChoice[];
  onEdit: (itemRef: string, field: ItemField, value: string | boolean | null | undefined, sourceName: string) => void;
  onResetItem: (itemRef: string) => void;
  onBulk: (rows: BulkRow[], op: BulkOp) => void;
  onMoveGroup: (rows: BulkRow[], project: string) => void;
}) {
  const t = useT();
  const [limit, setLimit] = useState(PAGE);
  // Drag and drop is a shortcut on top of the per-row project picker (which stays the keyboard path).
  const [dragRef, setDragRef] = useState<string | null>(null);
  const [overGroup, setOverGroup] = useState<string | null>(null);
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
          <section
            key={`${g.project}-${gi}`}
            aria-label={t("import.review.groupFor", { project: label })}
            onDragOver={(e) => {
              const dragged = dragRef ? rows.find((r) => r.item.itemRef === dragRef) : undefined;
              if (!dragged || dropProject(dragged.project, g.project) === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overGroup !== g.project) setOverGroup(g.project);
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverGroup(null); }}
            onDrop={(e) => {
              const dragged = dragRef ? rows.find((r) => r.item.itemRef === dragRef) : undefined;
              const target = dragged ? dropProject(dragged.project, g.project) : null;
              setOverGroup(null);
              setDragRef(null);
              if (!dragged || target === null) return;
              e.preventDefault();
              onEdit(dragged.item.itemRef, "project", target, dragged.item.name);
            }}
            style={{ borderRadius: "var(--r1)", outline: overGroup === g.project && dragRef ? "2px dashed var(--c-a)" : "none", outlineOffset: 6 }}
          >
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13, flex: "1 1 160px" }}>
                {label} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>({g.rows.length})</span>
              </div>
              <div style={{ flex: "1 1 200px", maxWidth: 280 }}>
                <label htmlFor={`imp-group-${gi}`} style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", marginBottom: 2 }}>{t("import.review.groupProject")}</label>
                <ProjectPicker id={`imp-group-${gi}`} value={g.project} projects={projects} onChange={(v) => v.trim() && v.trim() !== g.project && onMoveGroup(toBulk(g.rows), v)} />
              </div>
              {g.rows.every((r) => r.entry?.include === false) ? (
                <Btn variant="ghost" icon={CheckSquare} onClick={() => onBulk(toBulk(g.rows), { type: "include" })}>{t("import.review.includeGroup")}</Btn>
              ) : (
                <Btn variant="ghost" icon={Square} onClick={() => onBulk(toBulk(g.rows), { type: "exclude" })}>{t("import.review.excludeGroup")}</Btn>
              )}
              <ImportBulkBar count={g.rows.length} projects={projects} onApply={(op) => onBulk(toBulk(g.rows), op)} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {slice.map((r) => (
                <div key={r.item.itemRef} style={{ display: "flex", alignItems: "stretch", gap: 6, opacity: dragRef === r.item.itemRef ? 0.5 : 1 }}>
                  <span
                    draggable
                    aria-hidden
                    title={t("import.review.dragHint")}
                    data-testid="imp-drag-handle"
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", r.item.itemRef);
                      const rowEl = (e.currentTarget as HTMLElement).parentElement;
                      if (rowEl) e.dataTransfer.setDragImage(rowEl, 16, 16);
                      setDragRef(r.item.itemRef);
                    }}
                    onDragEnd={() => { setDragRef(null); setOverGroup(null); }}
                    style={{ display: "inline-flex", alignItems: "center", cursor: "grab", color: "var(--c-tx3)", flexShrink: 0, touchAction: "none" }}
                  >
                    <GripVertical size={16} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ImportMappingRow
                      rowKey={`imp-row-${r.item.itemRef.replace(/[^A-Za-z0-9_-]/g, "_")}`}
                      item={r.item}
                      eff={r.eff}
                      entry={r.entry}
                      conflicts={r.conflicts}
                      projects={projects}
                      onEdit={(field, value) => onEdit(r.item.itemRef, field, value, r.item.name)}
                      onReset={() => onResetItem(r.item.itemRef)}
                    />
                  </div>
                </div>
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
