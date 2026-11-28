"use client";

import { Tabs } from "./tabs-nav";
import { useT } from "../i18n/provider";
import { CAMPAIGN_BUCKETS, type CampaignFilter } from "../lib/campaign";

/**
 * Live / Done / Cancelled / All, with how many each holds, so hiding the cancelled ones never feels like losing them. One strip for the campaign
 * lists and the run list.
 */
export function CampaignFilterTabs({ value, onChange, counts }: { value: CampaignFilter; onChange: (f: CampaignFilter) => void; counts: Record<CampaignFilter, number> }) {
  const t = useT();
  const keys: CampaignFilter[] = [...CAMPAIGN_BUCKETS, "all"];
  return <Tabs label={t("migrationRun.filter.label")} active={value} onChange={(k) => onChange(k as CampaignFilter)} tabs={keys.map((k) => ({ key: k, label: t(`migrationRun.filter.${k}`), badge: counts[k] }))} />;
}
