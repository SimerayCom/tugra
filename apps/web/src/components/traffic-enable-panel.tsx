"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { api } from "../lib/api";
import type { ServerView } from "../lib/types";
import { useT } from "../i18n/provider";
import { Badge, Btn, EmptyState, Spinner } from "./ui";
import { useTrafficAnalyticsToggle } from "./traffic-analytics-card";

/** The Traffic page's empty / not-yet-collecting state: one-click enable/disable per server. New servers collect by
 *  default; this panel turns it on for any server currently off (or off for one you don't want). Viewers get a read-only explanation. */
export function TrafficEnablePanel({ teamId }: { teamId: string | null | undefined }) {
  const t = useT();
  const servers = useQuery({
    queryKey: ["servers", teamId ?? null],
    queryFn: () => api.listServers(teamId ? { teamId } : undefined),
  });

  const list = servers.data ?? [];
  const manageable = list.filter((s) => s.canWrite);
  const goServers = <Link href="/servers" className="tg-link" style={{ fontSize: 13 }}>{t("traffic.emptyAction")}</Link>;

  if (servers.isLoading) {
    return <div style={{ display: "flex", justifyContent: "center", padding: 16 }}><Spinner /></div>;
  }
  // No servers (or the list could not load): the plain note, pointing at Servers.
  if (servers.isError || list.length === 0) {
    return (
      <EmptyState icon={BarChart3} title={t("traffic.emptyTitle")} action={goServers}>
        {servers.isError ? t("traffic.emptyBody") : t("traffic.emptyNoServers")}
      </EmptyState>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--c-tx)", margin: "0 0 6px" }}>{t("traffic.emptyTitle")}</h2>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 10px", lineHeight: 1.5 }}>{t("traffic.emptyBody")}</p>
      {manageable.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: 0 }}>{t("traffic.enableViewerNote")}</p>
      ) : (
        <>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px", lineHeight: 1.5 }}>{t("traffic.enablePrivacy")}</p>
          <ul aria-label={t("traffic.enableListLabel")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {manageable.map((s) => <ServerRow key={s.id} server={s} />)}
          </ul>
        </>
      )}
      <div style={{ marginTop: 14 }}>{goServers}</div>
    </div>
  );
}

function ServerRow({ server }: { server: ServerView }) {
  const t = useT();
  const set = useTrafficAnalyticsToggle(server.id);
  // While a change is in flight show the requested value so the row feels instant.
  const on = set.isPending ? !!set.variables : server.trafficAnalytics;
  return (
    <li
      data-testid="traffic-enable-row"
      style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 12px", border: "1px solid var(--c-bd)", borderRadius: 8 }}
    >
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)", wordBreak: "break-word" }}>{server.name}</span>
          <Badge tone={on ? "ok" : "muted"}>{on ? t("traffic.enableStateOn") : t("traffic.enableStateOff")}</Badge>
        </div>
        {on && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 4 }}>{t("traffic.enableCollecting")}</div>}
      </div>
      <Btn
        variant={on ? "ghost" : "primary"}
        loading={set.isPending}
        disabled={set.isPending}
        aria-label={t(on ? "traffic.disableFor" : "traffic.enableFor", { name: server.name })}
        onClick={() => set.mutate(!on)}
      >
        {t(on ? "traffic.disableBtn" : "traffic.enableBtn")}
      </Btn>
    </li>
  );
}
