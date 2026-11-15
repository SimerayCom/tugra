"use client";

import type { CSSProperties } from "react";
import { useT } from "../../i18n/provider";

export interface RetentionValue {
  keep: string;
  days: string;
  sizeGb: string;
}

export function retentionFromFields(keep: number | null | undefined, days: number | null | undefined, sizeGb: number | null | undefined, defaultKeep = 7): RetentionValue {
  return { keep: keep != null ? String(keep) : String(defaultKeep), days: days != null ? String(days) : "", sizeGb: sizeGb != null ? String(sizeGb) : "" };
}

const num = (s: string): number | null => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
};

/** Wire fields: an empty input becomes null (clears the limit). `keepOptional` (per-volume policy) maps an empty keep to null = inherit. */
export function retentionToFields(v: RetentionValue, opts: { keepOptional?: boolean } = {}): { retention: number | null; retentionDays: number | null; maxSizeGb: number | null } {
  const keep = num(v.keep);
  return { retention: keep ?? (opts.keepOptional ? null : 7), retentionDays: num(v.days), maxSizeGb: num(v.sizeGb) };
}

const input: CSSProperties = {
  padding: "6px 8px",
  background: "var(--c-bg)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
  width: 100,
};

/** Keep-N copies, max age (days) and max total size (GB): whichever limit is reached first applies. */
export function RetentionFields({ value, onChange, hint }: { value: RetentionValue; onChange: (v: RetentionValue) => void; hint?: string }) {
  const t = useT();
  const label: CSSProperties = { fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label style={label}>
          {t("backups.keepCopies")}
          <input style={input} type="number" min={1} value={value.keep} onChange={(e) => onChange({ ...value, keep: e.target.value })} />
        </label>
        <label style={label}>
          {t("backups.maxAgeDays")}
          <input style={input} type="number" min={1} value={value.days} placeholder="∞" onChange={(e) => onChange({ ...value, days: e.target.value })} />
        </label>
        <label style={label}>
          {t("backups.maxSizeGb")}
          <input style={input} type="number" min={1} value={value.sizeGb} placeholder="∞" onChange={(e) => onChange({ ...value, sizeGb: e.target.value })} />
        </label>
      </div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.5 }}>{hint ?? t("backups.retentionHint")}</div>
    </div>
  );
}
