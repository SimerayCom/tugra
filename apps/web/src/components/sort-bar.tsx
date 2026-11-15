"use client";

import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { useT } from "../i18n/provider";
import type { SortDir } from "../lib/fleet";

/**
 * Sort controls for card-style lists (rows that aren't a <table>): one toggle button per sortable column,
 * mirroring the server table's header buttons — aria-pressed + a visually hidden direction, caret icon.
 */
export function SortBar<K extends string>({
  options,
  sort,
  onSort,
}: {
  options: { key: K; label: string }[];
  sort: { key: K; dir: SortDir } | null;
  onSort: (key: K) => void;
}) {
  const t = useT();
  return (
    <div role="group" aria-label={t("common.sortBy")} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--c-tx3)", marginRight: 2 }}>{t("common.sortBy")}:</span>
      {options.map((o) => {
        const active = sort?.key === o.key;
        const Caret = active ? (sort.dir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
        return (
          <button
            key={o.key}
            type="button"
            className="tg-row"
            data-sort-key={o.key}
            aria-pressed={active}
            onClick={() => onSort(o.key)}
            style={{ fontFamily: "inherit", fontSize: 12, fontWeight: active ? 700 : 400, color: active ? "var(--c-tx)" : "var(--c-tx3)", background: "transparent", border: "1px solid var(--c-bd)", padding: "3px 8px", borderRadius: 6, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            {o.label}
            {active && sort && <span className="sr-only"> {t(sort.dir === "asc" ? "common.sortedAsc" : "common.sortedDesc")}</span>}
            <Caret size={12} aria-hidden style={{ opacity: active ? 1 : 0.5 }} />
          </button>
        );
      })}
    </div>
  );
}
