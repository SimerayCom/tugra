"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { CampaignStatus } from "@tugra/shared";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { campaignReportHref, validCampaign } from "../lib/migration-run";
import { relativeTime } from "../lib/fleet";
import { Badge, SectionCard, Spinner } from "./ui";

const TONE: Record<CampaignStatus, "muted" | "lapis" | "warn" | "ok"> = { draft: "muted", running: "lapis", paused: "warn", done: "ok", cancelled: "muted" };

/**
 * The campaigns of a team (a mixed placement becomes one run per source server) with a link to each report. Team owner or admin: the hub
 * answers a member with a 403, which shows as "no campaign" rather than an error the person cannot act on.
 */
export function CampaignReportList({ teamId }: { teamId: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ["migration-campaigns", teamId], queryFn: () => api.listCampaigns(teamId), refetchInterval: 15_000 });
  return (
    <SectionCard title={t("coolifyMove.campaigns.title")} desc={t("coolifyMove.campaigns.desc")}>
      {q.isLoading && <Spinner />}
      {q.isError && <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--c-r)" }}>{t("coolifyMove.campaigns.error")}</p>}
      {q.data && q.data.length === 0 && <p data-testid="campaigns-none" style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("coolifyMove.campaigns.none")}</p>}
      {q.data && q.data.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="campaign-list">
          {q.data.map((c) => (
            <li key={c.id} style={{ borderTop: "1px solid var(--c-bd)", padding: "8px 0", display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center", minWidth: 0, fontSize: 13 }}>
              <strong style={{ flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere" }}>{c.label}</strong>
              <Badge tone={TONE[c.status]}>{t(`placement.campaign.status.${c.status}`)}</Badge>
              <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyMove.campaigns.runs", { count: c.runIds.length })}</span>
              <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{relativeTime(c.createdAt, t)}</span>
              {validCampaign(c.label) && (
                <Link href={campaignReportHref(c.label)} className="tg-link" style={{ fontSize: 12.5, minHeight: 44, display: "inline-flex", alignItems: "center" }}>
                  {t("coolifyMove.campaigns.open")}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
