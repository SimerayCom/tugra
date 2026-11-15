"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useT } from "../../i18n/provider";
import { formatSize } from "../../lib/backups";
import type { BackupDestination, BackupUsage } from "../../lib/types";
import { Btn } from "../ui";
import { ScheduleField, scheduleComplete, type ScheduleValue } from "./schedule-field";
import { RetentionFields, type RetentionValue } from "./retention-fields";

const GIB = 1024 ** 3;

/** Client-side usage for a list of SUCCESS backups (databases have no usage endpoint; volumes get it from the hub). */
export function usageFromBackups(rows: { status: string; sizeBytes: string | null }[], budgetGb: number | null): BackupUsage {
  const ok = rows.filter((r) => r.status === "SUCCESS");
  const used = ok.reduce((n, r) => n + (r.sizeBytes != null ? Number(r.sizeBytes) : 0), 0);
  return {
    pool: "app",
    usedBytes: String(used),
    backupCount: ok.length,
    unknownSizeCount: ok.filter((r) => r.sizeBytes == null).length,
    budgetGb,
    overBudget: budgetGb != null && used > budgetGb * GIB,
  };
}

function EncryptionBadge({ destinationId, destinations }: { destinationId: string; destinations: BackupDestination[] }) {
  const t = useT();
  const dest = destinationId ? destinations.find((d) => d.id === destinationId) : undefined;
  const base: CSSProperties = { fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--c-bd)" };
  if (dest?.encryptionEnabled) return <span data-testid="enc-badge" style={{ ...base, color: "var(--c-g)" }}>{t("backups.encrypted")}</span>;
  if (!destinationId || !dest) {
    // The implicit server-disk path has no row to hold a key, so it is always cleartext — say so and point at the fix.
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span data-testid="enc-badge" style={{ ...base, color: "var(--c-am)" }}>{t("backups.notEncryptedLocal")}</span>
        <Link href="/destinations" style={{ fontSize: 12, color: "var(--c-a)" }}>{t("backups.createEncryptedDest")}</Link>
      </span>
    );
  }
  return <span data-testid="enc-badge" style={{ ...base, color: "var(--c-am)" }}>{t("backups.notEncrypted")}</span>;
}

function StorageMeter({ usage, label }: { usage: BackupUsage; label?: string }) {
  const t = useT();
  const used = Number(usage.usedBytes);
  const pct = usage.budgetGb ? Math.min(100, (used / (usage.budgetGb * GIB)) * 100) : 0;
  const over = usage.overBudget;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{label}</div>}
      {usage.budgetGb != null ? (
        <>
          <div style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("backups.usedOfBudget", { used: formatSize(usage.usedBytes), budget: usage.budgetGb })}</div>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} style={{ height: 6, borderRadius: 3, background: "var(--c-el)", overflow: "hidden", maxWidth: 320 }}>
            <div style={{ width: `${pct}%`, height: "100%", background: over ? "var(--c-r)" : "var(--c-a)" }} />
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("backups.usedNoBudget", { used: formatSize(usage.usedBytes), count: usage.backupCount })}</div>
      )}
      {over && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("backups.overBudget")}</div>}
      {usage.unknownSizeCount > 0 && <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("backups.unknownSize", { count: usage.unknownSizeCount })}</div>}
    </div>
  );
}

const sel: CSSProperties = { padding: "6px 8px", background: "var(--c-bg)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit", maxWidth: "100%" };

/**
 * One backup policy editor: schedule, retention (count / age / size), destination, the destination's
 * encryption state and a storage meter. Shared by the database and app-volume backup cards.
 */
export function BackupPolicyCard({
  enabled,
  onEnabled,
  schedule,
  onSchedule,
  retention,
  onRetention,
  destinationId,
  onDestination,
  destinations,
  usage = [],
  minGapHours,
  onSave,
  saving,
  error,
  children,
}: {
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  schedule: ScheduleValue;
  onSchedule: (v: ScheduleValue) => void;
  retention: RetentionValue;
  onRetention: (v: RetentionValue) => void;
  destinationId: string;
  onDestination: (id: string) => void;
  destinations: BackupDestination[];
  usage?: BackupUsage[];
  minGapHours?: number;
  onSave: () => void;
  saving?: boolean;
  error?: string | null;
  children?: ReactNode;
}) {
  const t = useT();
  const canSave = !enabled || scheduleComplete(schedule);
  const heading: CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--c-tx2)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 16 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
        {t("backups.schedule")}
      </label>
      <section>
        <div style={heading}>{t("backups.schedule")}</div>
        <ScheduleField value={schedule} onChange={onSchedule} minGapHours={minGapHours} />
      </section>
      <section>
        <div style={heading}>{t("backups.retention")}</div>
        <RetentionFields value={retention} onChange={onRetention} />
      </section>
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={heading}>{t("backups.destination")}</div>
        <select style={{ ...sel, width: "auto" }} value={destinationId} onChange={(e) => onDestination(e.target.value)} aria-label={t("backups.destination")}>
          <option value="">{t("databases.localDisk")}</option>
          {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("backups.encryption")}</span>
          <EncryptionBadge destinationId={destinationId} destinations={destinations} />
        </div>
      </section>
      {usage.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={heading}>{t("backups.storage")}</div>
          {usage.map((u) => (
            <StorageMeter key={u.pool} usage={u} label={usage.length > 1 ? (u.pool === "app" ? t("backups.poolApp") : u.pool) : undefined} />
          ))}
        </section>
      )}
      {children}
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{error}</div>}
      <div>
        <Btn variant="ghost" onClick={onSave} disabled={saving || !canSave}>{saving ? t("backups.saving") : t("backups.save")}</Btn>
      </div>
    </div>
  );
}
