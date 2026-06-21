"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Box, Database, FolderTree, Server } from "lucide-react";
import { api } from "../../../lib/api";
import { statusCounts } from "../../../lib/fleet";
import { useT } from "../../../i18n/provider";
import { Card } from "../../../components/ui";

export default function DashboardPage() {
  const t = useT();
  const { data: servers = [], isLoading } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: apps = [] } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const { data: databases = [] } = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases() });
  const counts = statusCounts(servers);

  const stat = (label: string, value: number | string, color = "var(--c-tx)") => (
    <Card style={{ padding: 18, flex: 1, minWidth: 130 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>{value}</div>
    </Card>
  );

  const resource = (href: string, Icon: typeof Server, label: string, value: number | string) => (
    <Link href={href} style={{ textDecoration: "none", flex: 1, minWidth: 150 }}>
      <Card style={{ padding: 18, display: "flex", alignItems: "center", gap: 14 }}>
        <Icon size={26} color="var(--c-a)" />
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--c-tx)" }}>{value}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{label}</div>
        </div>
      </Card>
    </Link>
  );

  return (
    <div style={{ padding: 28 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("dashboard.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("dashboard.subtitle")}</p>

      <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("dashboard.resources")}</div>
      <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
        {resource("/projects", FolderTree, t("dashboard.projects"), projects.length)}
        {resource("/apps", Box, t("dashboard.apps"), apps.length)}
        {resource("/databases", Database, t("dashboard.databases"), databases.length)}
        {resource("/servers", Server, t("dashboard.totalServers"), isLoading ? "…" : servers.length)}
      </div>

      <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("dashboard.fleet")}</div>
      <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
        {stat(t("dashboard.online"), counts.ONLINE, "var(--c-g)")}
        {stat(t("dashboard.pending"), counts.PENDING, "var(--c-am)")}
        {stat(t("dashboard.offline"), counts.OFFLINE, "var(--c-r)")}
      </div>
      <Link href="/servers" style={{ color: "var(--c-a)", fontSize: 14, fontWeight: 600 }}>
        {t("dashboard.goToFleet")}
      </Link>
    </div>
  );
}
