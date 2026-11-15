"use client";

import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import type { ImportConflict, ImportResolved } from "../lib/types";

const LEVEL_ICON = { error: CircleAlert, warn: TriangleAlert, info: Info } as const;
const LEVEL_COLOR = { error: "var(--c-r)", warn: "var(--c-am)", info: "var(--c-tx3)" } as const;

/** Conflicts and notes, grouped by code. Every icon carries text (never colour alone); a conflict that needs an
 *  acknowledgement has a checkbox that writes `doc.acks`; clicking an item name focuses its row. */
export function ImportConflictsPanel({
  resolved,
  nameOf,
  onAck,
  onFocusItem,
  onRemoveOrphan,
  onRemoveAllOrphans,
}: {
  resolved: ImportResolved | null;
  nameOf: (itemRef: string) => string;
  onAck: (key: string, on: boolean) => void;
  onFocusItem: (itemRef: string) => void;
  onRemoveOrphan: (itemRef: string) => void;
  onRemoveAllOrphans: () => void;
}) {
  const t = useT();
  const conflicts = (resolved?.conflicts ?? []).filter((c) => c.code !== "key.orphan");
  const orphans = resolved?.orphans ?? [];
  const byCode = new Map<string, ImportConflict[]>();
  for (const c of conflicts) byCode.set(c.code, [...(byCode.get(c.code) ?? []), c]);
  const errors = conflicts.filter((c) => c.level === "error").length;
  const warnings = conflicts.filter((c) => c.level === "warn").length;
  return (
    <section aria-labelledby="imp-conflicts-title" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12 }}>
      <div id="imp-conflicts-title" style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
        {t("import.conflict.panelTitle")} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>· {t("import.conflict.live", { errors, warnings })}</span>
      </div>

      {orphans.length > 0 && (
        <div role="alert" style={{ border: "1px solid var(--c-r)", borderRadius: "var(--r1)", padding: 10, marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
            <CircleAlert size={14} aria-hidden style={{ color: "var(--c-r)" }} />
            <span style={{ flex: 1, minWidth: 180 }}>{t("import.review.orphans.banner", { count: orphans.length })}</span>
            <Btn variant="ghost" onClick={onRemoveAllOrphans}>{t("import.review.orphans.removeAll")}</Btn>
          </div>
          <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {orphans.map((ref) => (
              <li key={ref} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                <span className="mono" style={{ flex: 1, wordBreak: "break-all" }}>{ref}</span>
                <Btn variant="ghost" onClick={() => onRemoveOrphan(ref)}>{t("import.review.orphans.remove")}</Btn>
              </li>
            ))}
          </ul>
        </div>
      )}

      {byCode.size === 0 && orphans.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("import.conflict.none")}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[...byCode.entries()].map(([code, list]) => {
          const level = list[0].level;
          const Icon = LEVEL_ICON[level];
          return (
            <div key={code}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: LEVEL_COLOR[level] }}>
                <Icon size={14} aria-hidden />
                <span>{t(`import.conflict.level.${level}`)}</span>
                <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>({list.length})</span>
              </div>
              <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                {list.map((c, i) => (
                  <li key={`${c.itemRef ?? c.ref ?? ""}-${i}`} style={{ fontSize: 12 }}>
                    {c.itemRef && (
                      <button type="button" onClick={() => onFocusItem(c.itemRef!)} aria-label={t("import.conflict.itemLink", { name: nameOf(c.itemRef) })} style={{ all: "unset", cursor: "pointer", textDecoration: "underline", marginRight: 6, minHeight: 24 }}>
                        {nameOf(c.itemRef)}
                      </button>
                    )}
                    <span>{t(`import.conflict.${c.code}`, c.params)}</span>
                    {c.requiresAck && c.ackKey && (
                      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, minHeight: 32, cursor: "pointer" }}>
                        <input type="checkbox" checked={!!c.acked} onChange={(e) => onAck(c.ackKey!, e.target.checked)} />
                        <span>{t(`import.review.ack.${c.code}`)}</span>
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
