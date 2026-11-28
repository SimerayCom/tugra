"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CampaignReport } from "../../../../../components/migration-run/campaign-report";
import { CampaignById } from "../../../../../components/migration-run/campaign-by-id";
import { Spinner } from "../../../../../components/ui";

/** `/import/runs/campaign?id=<campaign id>`. A link made before ids existed (`?c=<label>`) still opens the same report. */
function CampaignReportPage() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  if (id) return <CampaignById id={id} />;
  return <CampaignReport campaign={params.get("c") ?? ""} />;
}

export default function MigrationCampaignPage() {
  return (
    <Suspense fallback={<div style={{ padding: "var(--page-pad)" }}><Spinner /></div>}>
      <CampaignReportPage />
    </Suspense>
  );
}
