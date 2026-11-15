"use client";

import { useEffect, useId, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";

export interface ScheduleValue {
  mode: "interval" | "cron";
  hours: string;
  cron: string;
}

export const CRON_PRESETS: { key: "hourly" | "daily" | "weekly" | "monthly"; cron: string }[] = [
  { key: "hourly", cron: "0 * * * *" },
  { key: "daily", cron: "0 3 * * *" },
  { key: "weekly", cron: "0 3 * * 0" },
  { key: "monthly", cron: "0 3 1 * *" },
];

/** Build the editor value from stored fields (a stored cron wins over the interval, like the hub). */
export function scheduleFromFields(intervalHours: number | null | undefined, cron: string | null | undefined, defaultHours = 24): ScheduleValue {
  return cron
    ? { mode: "cron", hours: String(intervalHours ?? defaultHours), cron }
    : { mode: "interval", hours: String(intervalHours ?? defaultHours), cron: "" };
}

/** The wire fields for the value: the INACTIVE mode sends null, so switching modes really clears the other. */
export function scheduleToFields(v: ScheduleValue): { intervalHours: number | null; cron: string | null } {
  if (v.mode === "cron") return { intervalHours: null, cron: v.cron.trim() || null };
  return { intervalHours: Math.max(1, Math.floor(Number(v.hours)) || 24), cron: null };
}

/** True when the value can be sent as an ENABLED schedule (a cron-mode value needs an expression). */
export function scheduleComplete(v: ScheduleValue): boolean {
  return v.mode === "interval" ? Number(v.hours) >= 1 : v.cron.trim().length > 0;
}

const input: CSSProperties = {
  padding: "6px 8px",
  background: "var(--c-bg)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

const chip = (active: boolean): CSSProperties => ({
  padding: "4px 10px",
  borderRadius: 999,
  border: `1px solid ${active ? "var(--c-a)" : "var(--c-bd)"}`,
  background: active ? "var(--c-a)" : "transparent",
  color: active ? "var(--c-on-a)" : "var(--c-tx2)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
});

/** An ISO instant formatted in the HUB's timezone (the cron fires there), falling back to the browser's local
 *  format when the zone string is missing or not understood by this browser. */
export function formatInZone(iso: string, timeZone: string | null | undefined): string {
  const d = new Date(iso);
  if (timeZone) {
    try {
      return d.toLocaleString(undefined, { timeZone });
    } catch {
      /* unknown zone: fall through to the browser's own zone */
    }
  }
  return d.toLocaleString();
}

/**
 * Schedule editor shared by database, volume and hub backups: an "every N hours" interval OR a 5-field cron
 * (presets + custom) with a live preview of the next fires in the hub's timezone. `minGapHours` flags a cron
 * that can fire more often than the resource allows (the hub rejects it; this just says so before saving).
 */
export function ScheduleField({ value, onChange, minGapHours }: { value: ScheduleValue; onChange: (v: ScheduleValue) => void; minGapHours?: number }) {
  const t = useT();
  // A unique radio group per editor: the app volume card and a per-volume policy modal can be mounted together, and
  // same-named radios outside a <form> form ONE native group (arrow keys / checked state would cross editors).
  const groupName = `schedule-mode-${useId()}`;
  const cron = value.cron.trim();
  // Debounce the cron so we don't hit the preview endpoint on every keystroke.
  const [debounced, setDebounced] = useState(cron);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(cron), 300);
    return () => clearTimeout(h);
  }, [cron]);
  const wantPreview = value.mode === "cron" && debounced.length > 0;
  const { data: preview } = useQuery({
    queryKey: ["cronPreview", debounced],
    queryFn: () => api.previewSchedule(debounced, 3),
    enabled: wantPreview,
    staleTime: 60_000,
    retry: false,
  });
  const presetMatch = CRON_PRESETS.find((p) => p.cron === cron)?.key ?? null;
  const tooFrequent = !!preview?.valid && minGapHours != null && preview.minGapSeconds != null && preview.minGapSeconds < minGapHours * 3600;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div role="radiogroup" aria-label={t("backups.schedule")} style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13, color: "var(--c-tx2)" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="radio" name={groupName} checked={value.mode === "interval"} onChange={() => onChange({ ...value, mode: "interval" })} />
          {t("backups.scheduleInterval")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="radio" name={groupName} checked={value.mode === "cron"} onChange={() => onChange({ ...value, mode: "cron", cron: value.cron || CRON_PRESETS[1].cron })} />
          {t("backups.scheduleCron")}
        </label>
      </div>

      {value.mode === "interval" ? (
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("backups.everyHours")}
          <input style={{ ...input, width: 90 }} type="number" min={1} value={value.hours} onChange={(e) => onChange({ ...value, hours: e.target.value })} />
        </label>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {CRON_PRESETS.map((p) => (
              <button key={p.key} type="button" style={chip(presetMatch === p.key)} aria-pressed={presetMatch === p.key} onClick={() => onChange({ ...value, cron: p.cron })}>
                {t(`backups.preset.${p.key}`)}
              </button>
            ))}
            <button type="button" style={chip(presetMatch === null)} aria-pressed={presetMatch === null} onClick={() => onChange({ ...value, cron: presetMatch ? "" : value.cron })}>
              {t("backups.preset.custom")}
            </button>
          </div>
          <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
            {t("backups.cronExpression")}
            <input className="mono" style={{ ...input, maxWidth: 260 }} value={value.cron} onChange={(e) => onChange({ ...value, cron: e.target.value })} placeholder="0 3 * * *" spellCheck={false} />
          </label>
          {wantPreview && preview && !preview.valid && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("backups.cronInvalid")}</div>}
          {tooFrequent && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("backups.cronTooFrequent")}</div>}
          {wantPreview && preview?.valid && (
            <div style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>
              <div style={{ fontWeight: 600, color: "var(--c-tx2)" }}>{t("backups.nextRuns")}</div>
              <ul style={{ margin: "2px 0", paddingLeft: 18 }}>
                {preview.nextRuns.map((r) => <li key={r}>{formatInZone(r, preview.timezone)}</li>)}
              </ul>
              <div>{t("backups.nextRunsTz", { tz: preview.timezone })}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
