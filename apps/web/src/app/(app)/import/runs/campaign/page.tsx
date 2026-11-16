"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CampaignReport } from "../../../../../components/migration-run/campaign-report";
import { Spinner } from "../../../../../components/ui";

function CampaignReportPage() {
  const campaign = useSearchParams().get("c") ?? "";
  return <CampaignReport campaign={campaign} />;
}

export default function MigrationCampaignPage() {
  return (
    <Suspense fallback={<div style={{ padding: "var(--page-pad)" }}><Spinner /></div>}>
      <CampaignReportPage />
    </Suspense>
  );
}
