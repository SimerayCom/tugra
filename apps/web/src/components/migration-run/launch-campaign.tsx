"use client";

import { useT } from "../../i18n/provider";
import type { CampaignPreview } from "../../lib/api";
import { placementFailureKey, runsByWave, sourcesOfRun } from "../../lib/campaign";
import { UNKNOWN_SOURCE_HOST, type SourceServerRow } from "../../lib/migration-run";

/**
 * What a mixed placement becomes, shown before anything is created: one run for the servers that move to another server, then one run per server
 * that stays on its own machine, in waves. Names only. A refused placement says why, in words, and the create button stays off.
 */
export function CampaignPreviewCard({
  preview,
  loading,
  failed,
  rows,
  servers,
}: {
  preview: CampaignPreview | null;
  loading: boolean;
  failed: boolean;
  rows: SourceServerRow[];
  servers: Array<{ id: string; name: string }>;
}) {
  const t = useT();
  const nameOfSource = (ref: string): string => {
    const r = rows.find((x) => x.ref === ref);
    return ref === UNKNOWN_SOURCE_HOST ? t("migrationRun.launch.placement.unknownHost") : (r?.name ?? ref);
  };
  const nameOfServer = (id: string): string => servers.find((s) => s.id === id)?.name ?? id;
  return (
    <fieldset data-testid="campaign-preview" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, margin: 0, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <legend style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx2)", padding: "0 6px" }}>{t("placement.campaign.title")}</legend>
      <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("placement.campaign.hint")}</p>
      {loading && <p role="status" style={{ margin: 0, fontSize: 12 }}>{t("placement.campaign.checking")}</p>}
      {failed && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-r)" }}>{t("placement.campaign.unreadable")}</p>}
      {preview?.failure && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-r)", lineHeight: 1.5 }}>
          {t(placementFailureKey(preview.failure.code))}
          {preview.failure.ref ? ` (${nameOfSource(preview.failure.ref)})` : ""}
          {preview.failure.reason ? ` ${t(`placement.lock.${preview.failure.reason}`)}` : ""}
        </p>
      )}
      {preview?.runs && (
        <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontSize: 12, lineHeight: 1.5 }}>
          {runsByWave(preview.runs).flatMap((w) =>
            w.runs.map((r) => (
              <li key={`${w.wave}:${r.sourceServerRef}`}>
                <strong>{t("placement.campaign.wave", { n: w.wave + 1 })}</strong>
                {": "}
                {r.kind === "in-place" ? t("placement.campaign.runInPlace", { source: sourcesOfRun(r).map(nameOfSource).join(", ") }) : t("placement.campaign.runOther", { source: sourcesOfRun(r).map(nameOfSource).join(", "), target: nameOfServer(r.targetServerId) })}
              </li>
            )),
          )}
        </ol>
      )}
    </fieldset>
  );
}
