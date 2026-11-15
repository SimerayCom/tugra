"use client";

import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { fmtBytes } from "../../lib/fleet";
import { bucketPct, nextActions, overallPct } from "../../lib/object-migration";
import type { ObjectBucketStatus, ObjectMigrationView } from "../../lib/types";

/** Literal keys so static key-usage checks keep working. */
const BUCKET_STATUS_KEY: Record<ObjectBucketStatus, string> = {
  PENDING: "objectMigration.bucketStatus.PENDING",
  QUEUED: "objectMigration.bucketStatus.QUEUED",
  SEEDING: "objectMigration.bucketStatus.SEEDING",
  SEEDED: "objectMigration.bucketStatus.SEEDED",
  FINALIZING: "objectMigration.bucketStatus.FINALIZING",
  FINAL: "objectMigration.bucketStatus.FINAL",
  VERIFIED: "objectMigration.bucketStatus.VERIFIED",
  DIFFERS: "objectMigration.bucketStatus.DIFFERS",
  FAILED: "objectMigration.bucketStatus.FAILED",
};
const ERROR_KEY: Record<string, string> = {
  "access-denied": "objectMigration.error.access-denied",
  "no-such-bucket": "objectMigration.error.no-such-bucket",
  unreachable: "objectMigration.error.unreachable",
  signature: "objectMigration.error.signature",
  quota: "objectMigration.error.quota",
  timeout: "objectMigration.error.timeout",
  "run-failed": "objectMigration.error.run-failed",
  "mirror-failed": "objectMigration.error.mirror-failed",
  "mirror-errors": "objectMigration.error.mirror-errors",
  "helper-missing": "objectMigration.error.helper-missing",
  "verify-failed": "objectMigration.error.verify-failed",
};
const statusColor = (s: ObjectBucketStatus): string => (s === "FAILED" || s === "DIFFERS" ? "var(--c-r)" : s === "SEEDED" || s === "FINAL" || s === "VERIFIED" ? "var(--c-g)" : "var(--c-am)");

export interface PhaseHandlers {
  onSeed: () => void;
  onFinal: () => void;
  onVerify: () => void;
  onCancel: () => void;
  mergeAck: boolean;
  onMergeAck: (v: boolean) => void;
  needsMergeAck: boolean;
  busy: boolean;
}

/** Seed / final / verify / cancel buttons + per-bucket progress bars, status, the verify result and the last classified error. */
export function PhasePanel({ m, h }: { m: ObjectMigrationView; h: PhaseHandlers }) {
  const t = useT();
  const act = nextActions(m);
  const selected = m.buckets.filter((b) => b.selected);
  const total = overallPct(m);
  const queued = selected.some((b) => b.status === "QUEUED");
  return (
    <SectionCard title={t("objectMigration.title")} style={{ padding: 16, marginBottom: 0 }}>
      {h.needsMergeAck && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: "var(--c-am)", marginBottom: 10 }}>
          <input type="checkbox" checked={h.mergeAck} onChange={(e) => h.onMergeAck(e.target.checked)} style={{ marginTop: 3 }} />
          {t("objectMigration.phase.mergeAck")}
        </label>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        <Btn onClick={h.onSeed} disabled={!act.seed || h.busy || (h.needsMergeAck && !h.mergeAck)}>{m.status === "FAILED" || m.status === "SEEDED" ? t("objectMigration.phase.resume") : t("objectMigration.phase.seed")}</Btn>
        <Btn variant="ghost" onClick={h.onFinal} disabled={!act.final || h.busy}>{t("objectMigration.phase.final")}</Btn>
        <Btn variant="ghost" onClick={h.onVerify} disabled={!act.verify || h.busy}>{t("objectMigration.phase.verify")}</Btn>
        {act.cancel && <Btn variant="ghost" onClick={h.onCancel} disabled={h.busy}>{t("objectMigration.phase.cancel")}</Btn>}
      </div>
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("objectMigration.phase.seedHint")} {t("objectMigration.phase.finalHint")}</p>
      {total !== null && (
        <div role="progressbar" aria-valuenow={total} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, background: "var(--c-sur)", borderRadius: 4, overflow: "hidden", marginBottom: 12 }}>
          <div style={{ width: `${total}%`, height: "100%", background: "var(--c-g)", transition: "width .4s" }} />
        </div>
      )}
      {queued && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 8px" }}>{t("objectMigration.phase.retrying")}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {selected.map((b) => {
          const pct = bucketPct(b);
          return (
            <div key={b.srcBucket} style={{ borderBottom: "1px solid var(--c-bd)", paddingBottom: 8 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", fontSize: 12 }}>
                <span className="mono" style={{ fontWeight: 600, wordBreak: "break-all" }}>{b.srcBucket}{b.dstBucket !== b.srcBucket ? ` -> ${b.dstBucket}` : ""}</span>
                <span style={{ color: statusColor(b.status), fontWeight: 600 }}>{t(BUCKET_STATUS_KEY[b.status])}</span>
                {pct !== null && <span style={{ color: "var(--c-tx3)" }}>{pct}%</span>}
                {b.doneBytes !== null && b.srcBytes !== null && (b.status === "SEEDING" || b.status === "FINALIZING") && <span style={{ color: "var(--c-tx3)" }}>{fmtBytes(b.doneBytes)} / {fmtBytes(b.srcBytes)}</span>}
              </div>
              {pct !== null && (b.status === "SEEDING" || b.status === "FINALIZING") && (
                <div role="progressbar" aria-label={b.srcBucket} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 5, background: "var(--c-sur)", borderRadius: 3, overflow: "hidden", marginTop: 4 }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: "var(--c-a)" }} />
                </div>
              )}
              {b.lastError && <div role="alert" style={{ fontSize: 11, color: "var(--c-r)", marginTop: 3 }}>{t(ERROR_KEY[b.lastError] ?? "objectMigration.error.mirror-failed")}</div>}
              {b.diffMissing !== null && (
                <div style={{ fontSize: 11, marginTop: 3, color: b.diffMissing === 0 && b.diffDiffer === 0 ? "var(--c-g)" : "var(--c-am)" }}>
                  {b.diffMissing === 0 && b.diffDiffer === 0 ? t("objectMigration.verify.ok") : `${t("objectMigration.verify.missing", { n: b.diffMissing })} - ${t("objectMigration.verify.differ", { n: b.diffDiffer ?? 0 })}`}
                  {(b.diffExtra ?? 0) > 0 ? ` - ${t("objectMigration.verify.extra", { n: b.diffExtra ?? 0 })}` : ""}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "10px 0 0" }}>{t("objectMigration.verify.keysSizesOnly")}</p>
    </SectionCard>
  );
}
