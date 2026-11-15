"use client";

import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import type { ObjectBucketView } from "../../lib/types";

/** Exported anonymous policy / lifecycle / tags per selected bucket (presence only) and the "apply to destination" action. */
export function ConfigCarry({ buckets, canCarry, busy, onCarry }: { buckets: ObjectBucketView[]; canCarry: boolean; busy: boolean; onCarry: () => void }) {
  const t = useT();
  const rows = buckets.filter((b) => b.selected && b.configSummary && (b.configSummary.policy || b.configSummary.lifecycle || b.configSummary.tags));
  return (
    <SectionCard title={t("objectMigration.config.title")} desc={t("objectMigration.config.notCarried")} style={{ padding: 16, marginBottom: 0 }}>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("objectMigration.config.none")}</p>
      ) : (
        <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 12 }}>
          {rows.map((b) => (
            <li key={b.srcBucket}>
              <span className="mono">{b.srcBucket}</span>:{" "}
              {[b.configSummary!.policy && t("objectMigration.config.policy"), b.configSummary!.lifecycle && t("objectMigration.config.lifecycle"), b.configSummary!.tags && t("objectMigration.config.tags")].filter(Boolean).join(", ")}
              {b.configStatus === "APPLIED" && <span style={{ color: "var(--c-g)" }}> - {t("objectMigration.config.applied")}</span>}
              {b.configStatus === "FAILED" && <span style={{ color: "var(--c-r)" }}> - {t("objectMigration.config.failed")}</span>}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <Btn onClick={onCarry} disabled={!canCarry || busy}>{busy ? t("objectMigration.config.carrying") : t("objectMigration.config.carry")}</Btn>
      )}
    </SectionCard>
  );
}
