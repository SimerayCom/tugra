"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useT } from "../../../../i18n/provider";
import { TakeoverPanel } from "../../../../components/coolify-inplace/takeover-panel";
import { Spinner } from "../../../../components/ui";

function InPlacePage() {
  const t = useT();
  const sp = useSearchParams();
  const serverId = sp.get("serverId") ?? "";
  const opId = sp.get("opId") ?? undefined;
  const server = useQuery({ queryKey: ["server", serverId], queryFn: () => api.getServer(serverId), enabled: !!serverId });
  return (
    <div style={{ padding: "24px 20px", maxWidth: 900, margin: "0 auto" }}>
      <p style={{ fontSize: 12, margin: "0 0 8px" }}>
        <Link href="/import/move-off-coolify">{t("coolifyInPlace.back")}</Link>
      </p>
      {!serverId ? <p role="alert" style={{ fontSize: 13 }}>{t("coolifyInPlace.missing")}</p> : server.isLoading ? <Spinner /> : server.data ? <TakeoverPanel serverId={serverId} serverName={server.data.name} opId={opId} /> : <p role="alert" style={{ fontSize: 13 }}>{t("coolifyInPlace.error.generic")}</p>}
    </div>
  );
}

export default function InPlaceTakeoverPage() {
  return (
    <Suspense fallback={<div style={{ padding: "var(--page-pad)" }}><Spinner /></div>}>
      <InPlacePage />
    </Suspense>
  );
}
