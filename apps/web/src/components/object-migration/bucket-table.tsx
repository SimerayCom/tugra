"use client";

import { useEffect, useState } from "react";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { fmtBytes } from "../../lib/fleet";
import { parseExcludes, sortBySize } from "../../lib/object-migration";
import type { ObjectBucketView } from "../../lib/types";

export interface BucketEdit {
  selected: boolean;
  dst: string;
  exclude: string;
}

/**
 * The bucket picker: size-sorted (largest first), a checkbox per bucket, an optional rename and exclude globs.
 * NOTHING is pre-selected: the operator chooses (a big bucket may just hold backups). Saves the whole selection at once.
 */
export function BucketTable({ buckets, canEdit, saving, onSave }: { buckets: ObjectBucketView[]; canEdit: boolean; saving: boolean; onSave: (rows: Array<{ srcBucket: string; dstBucket: string; selected: boolean; exclude: string[] }>) => void }) {
  const t = useT();
  const sorted = sortBySize(buckets);
  const [edits, setEdits] = useState<Record<string, BucketEdit>>({});
  // Re-seed the local edits from the server view whenever the set or its saved values change.
  const sig = buckets.map((b) => `${b.srcBucket}|${b.selected}|${b.dstBucket}|${b.exclude.join(",")}`).join(";");
  useEffect(() => {
    setEdits(Object.fromEntries(buckets.map((b) => [b.srcBucket, { selected: b.selected, dst: b.dstBucket, exclude: b.exclude.join(", ") }])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const get = (b: ObjectBucketView): BucketEdit => edits[b.srcBucket] ?? { selected: b.selected, dst: b.dstBucket, exclude: b.exclude.join(", ") };
  const set = (b: ObjectBucketView, patch: Partial<BucketEdit>) => setEdits({ ...edits, [b.srcBucket]: { ...get(b), ...patch } });
  const anySelected = sorted.some((b) => get(b).selected);
  const allSelected = sorted.length > 0 && sorted.every((b) => get(b).selected);
  return (
    <SectionCard
      title={t("objectMigration.buckets.title")}
      desc={anySelected ? undefined : t("objectMigration.buckets.nonePreselected")}
      right={
        canEdit && sorted.length > 0 ? (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" onClick={() => setEdits(Object.fromEntries(sorted.map((b) => [b.srcBucket, { ...get(b), selected: !allSelected }])))}>{t("objectMigration.buckets.selectAll")}</Btn>
            <Btn onClick={() => onSave(sorted.map((b) => ({ srcBucket: b.srcBucket, dstBucket: get(b).dst.trim() || b.srcBucket, selected: get(b).selected, exclude: parseExcludes(get(b).exclude) })))} disabled={saving}>
              {saving ? t("objectMigration.buckets.saving") : t("objectMigration.buckets.save")}
            </Btn>
          </div>
        ) : undefined
      }
      style={{ padding: 16, marginBottom: 0 }}
    >
      {sorted.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("objectMigration.buckets.none")}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sorted.map((b) => {
            const e = get(b);
            const locked = !canEdit || b.status !== "PENDING";
            return (
              <div key={b.srcBucket} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "start" }}>
                <input type="checkbox" aria-label={`${t("objectMigration.buckets.select")} ${b.srcBucket}`} checked={e.selected} disabled={!canEdit || b.status === "QUEUED" || b.status === "SEEDING" || b.status === "FINALIZING"} onChange={(ev) => set(b, { selected: ev.target.checked })} style={{ marginTop: 3 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
                    <span className="mono" style={{ fontSize: 13, fontWeight: 600, wordBreak: "break-all" }}>{b.srcBucket}</span>
                    <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>
                      {b.srcBytes === null ? t("objectMigration.buckets.unknownSize") : fmtBytes(b.srcBytes)}
                      {b.srcObjects !== null ? ` - ${b.srcObjects.toLocaleString()} ${t("objectMigration.buckets.objects")}` : ""}
                    </span>
                    {(b.dstObjects ?? 0) > 0 && <span style={{ fontSize: 11, color: "var(--c-am)" }}>{t("objectMigration.buckets.destExists", { n: (b.dstObjects ?? 0).toLocaleString() })}</span>}
                  </div>
                  {e.selected && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginTop: 8 }}>
                      <label style={{ fontSize: 11, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 3 }}>
                        {t("objectMigration.buckets.rename")}
                        <input className="mono" value={e.dst} disabled={locked} onChange={(ev) => set(b, { dst: ev.target.value })} style={inputStyle} spellCheck={false} />
                      </label>
                      <label style={{ fontSize: 11, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 3 }}>
                        {t("objectMigration.buckets.exclude")}
                        <input className="mono" value={e.exclude} disabled={locked} onChange={(ev) => set(b, { exclude: ev.target.value })} style={inputStyle} spellCheck={false} placeholder="tmp/*, *.log" />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

const inputStyle: React.CSSProperties = { padding: "6px 8px", fontSize: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", width: "100%", boxSizing: "border-box" };
