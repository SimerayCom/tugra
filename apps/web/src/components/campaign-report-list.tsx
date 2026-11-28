"use client";

import Link from "next/link";
import { useQueries } from "@tanstack/react-query";
import type { CampaignStatus } from "@tugra/shared";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { useState } from "react";
import { CAMPAIGN_BUCKETS, campaignBucket, campaignHref, campaignTitle, groupCampaigns, matchesCampaignFilter, type CampaignFilter } from "../lib/campaign";
import { CampaignFilterTabs } from "./campaign-filter";
import { useTeamContext, useTeamScope } from "./team-scope";
import { relativeTime } from "../lib/fleet";
import { Badge, SectionCard, Spinner } from "./ui";

const TONE: Record<CampaignStatus, "muted" | "lapis" | "warn" | "ok"> = { draft: "muted", running: "lapis", paused: "warn", done: "ok", cancelled: "muted" };

/** What the list shows by default: the moves that are going or wait for the owner. Cancelled and finished ones are one tab away, with their count. */
const DEFAULT_FILTER: CampaignFilter = "live";

/**
 * The campaigns of a team (a mixed placement becomes one run per source server) with a link to each report. Team owner or admin: the hub
 * answers a member with a 403, which shows as "no campaign" rather than an error the person cannot act on. A move onto servers of several
 * teams is one campaign per team under one label: the teams listed in `teamIds` are read together and shown as one line per label.
 */
export function CampaignReportList({ teamId, extraTeamIds = [] }: { teamId: string; extraTeamIds?: readonly string[] }) {
  const t = useT();
  const ids = [...new Set([teamId, ...extraTeamIds])];
  const qs = useQueries({ queries: ids.map((id) => ({ queryKey: ["migration-campaigns", id], queryFn: () => api.listCampaigns(id), refetchInterval: 15_000 })) });
  const loading = qs.some((q) => q.isLoading);
  // the team of the page decides whether the list could be read at all; another team that refuses just has nothing to add
  const failed = qs[0].isError;
  const [filter, setFilter] = useState<CampaignFilter>(DEFAULT_FILTER);
  const all = groupCampaigns(qs.flatMap((q) => q.data ?? []));
  const counts = { all: all.length, ...Object.fromEntries(CAMPAIGN_BUCKETS.map((b) => [b, all.filter((g) => campaignBucket(g.status) === b).length])) } as Record<CampaignFilter, number>;
  const rows = all.filter((g) => matchesCampaignFilter(g.status, filter));
  const loaded = !loading && !failed;
  return (
    <SectionCard title={t("coolifyMove.campaigns.title")} desc={t("coolifyMove.campaigns.desc")}>
      {loading && <Spinner />}
      {failed && <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--c-r)" }}>{t("coolifyMove.campaigns.error")}</p>}
      {loaded && all.length === 0 && <p data-testid="campaigns-none" style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("coolifyMove.campaigns.none")}</p>}
      {loaded && all.length > 0 && <CampaignFilterTabs value={filter} onChange={setFilter} counts={counts} />}
      {loaded && all.length > 0 && rows.length === 0 && <p data-testid="campaigns-filtered-none" style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("coolifyMove.campaigns.noneInFilter")}</p>}
      {loaded && rows.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="campaign-list">
          {rows.map((c) => (
            <li key={c.label} style={{ borderTop: "1px solid var(--c-bd)" }}>
              {/* the whole row is the link: nothing to aim for on a phone */}
              <Link href={campaignHref(c.id)} aria-label={t("coolifyMove.campaigns.openNamed", { name: campaignTitle(t, c.label, c.createdAt) })} style={{ padding: "8px 0", minHeight: 44, display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center", minWidth: 0, fontSize: 13, color: "inherit", textDecoration: "none" }}>
                <strong style={{ flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere" }}>{campaignTitle(t, c.label, c.createdAt)}</strong>
                <Badge tone={TONE[c.status]}>{t(`placement.campaign.status.${c.status}`)}</Badge>
                <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyMove.campaigns.runs", { count: c.runs })}</span>
                {c.teams > 1 && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyMove.campaigns.teams", { count: c.teams })}</span>}
                <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{relativeTime(c.createdAt, t)}</span>
                <span className="tg-link" style={{ fontSize: 12.5 }}>{t("coolifyMove.campaigns.open")}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/**
 * The report list for the team the person is looking at (an owner or admin of it); nothing for a member, who has no campaigns to open.
 * With every team in view (no team picked) it reads the campaigns of all the teams the person owns or administers.
 */
export function TeamCampaignReportList() {
  const { teams } = useTeamContext();
  const { teamId: scope } = useTeamScope();
  const eligible = teams.filter((tm) => tm.role === "OWNER" || tm.role === "ADMIN");
  const picked = eligible.find((tm) => tm.id === scope)?.id;
  const teamId = picked ?? eligible[0]?.id;
  return teamId ? <CampaignReportList teamId={teamId} extraTeamIds={picked ? [] : eligible.map((tm) => tm.id)} /> : null;
}
