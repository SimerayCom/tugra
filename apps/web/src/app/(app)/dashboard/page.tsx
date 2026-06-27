"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Box, Database, FolderTree, Plus, Server, Settings } from "lucide-react";
import { api } from "../../../lib/api";
import { statusCounts } from "../../../lib/fleet";
import type { ServerStatus } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Badge, Card, StatusPill } from "../../../components/ui";

const serverColor = (s: ServerStatus) =>
  s === "ONLINE" ? "var(--c-g)" : s === "PENDING" ? "var(--c-am)" : "var(--c-r)";
const logoBox: React.CSSProperties = {
  width: 40, height: 40, borderRadius: 9, background: "rgba(255,255,255,0.06)",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
const sectionTitle: React.CSSProperties = {
  fontSize: 11, color: "var(--c-tx3)", margin: "0 0 10px", fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.06em",
};

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
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("dashboard.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("dashboard.subtitle")}</p>

      <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("dashboard.resources")}</div>
      <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
        {resource("/projects", FolderTree, t("dashboard.projects"), projects.length)}
        {resource("/apps", Box, t("dashboard.apps"), apps.length)}
        {resource("/databases", Database, t("dashboard.databases"), databases.length)}
        {resource("/servers", Server, t("dashboard.totalServers"), isLoading ? "…" : servers.length)}
      </div>

      <div style={sectionTitle}>{t("dashboard.fleet")}</div>
      <div style={{ display: "flex", gap: 14, marginBottom: 28, flexWrap: "wrap" }}>
        {stat(t("dashboard.online"), counts.ONLINE, "var(--c-g)")}
        {stat(t("dashboard.pending"), counts.PENDING, "var(--c-am)")}
        {stat(t("dashboard.offline"), counts.OFFLINE, "var(--c-r)")}
      </div>

      {/* Projects (Coolify-style cards with quick actions) */}
      <div style={sectionTitle}>{t("dashboard.projects")}</div>
      {projects.length === 0 ? (
        <Card style={{ padding: 20, marginBottom: 28, fontSize: 13, color: "var(--c-tx3)" }}>
          {t("dashboard.noProjects")} <Link href="/projects" style={{ color: "var(--c-a)" }}>{t("projects.create")}</Link>
        </Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, marginBottom: 28 }}>
          {projects.map((p) => {
            const appCount = p.environments.reduce((n, e) => n + e.appCount, 0);
            const dbCount = p.environments.reduce((n, e) => n + e.dbCount, 0);
            const env = p.environments[0]?.id ?? "";
            return (
              <Card key={p.id} style={{ padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={logoBox}><FolderTree size={20} color="var(--c-a)" /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link href={`/projects/${p.id}`} style={{ fontWeight: 600, fontSize: 14, color: "var(--c-tx)", textDecoration: "none" }}>{p.name}</Link>
                    <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                      <Badge>{p.environments.length} env</Badge>
                      <Badge>{appCount} apps</Badge>
                      <Badge>{dbCount} dbs</Badge>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Link href={`/resources/new?project=${p.id}&env=${env}`} style={chip}><Plus size={13} /> {t("dashboard.addResource")}</Link>
                  <Link href={`/projects/${p.id}`} style={chip}><Settings size={13} /> {t("dashboard.settings")}</Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Servers */}
      <div style={sectionTitle}>{t("dashboard.servers")}</div>
      <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
        {servers.map((s) => (
          <Link key={s.id} href={`/servers/${s.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
            <span style={logoBox}><Server size={18} color="var(--c-a)" /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
              {s.hostname && <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{s.hostname}</div>}
            </div>
            <StatusPill label={s.status} color={serverColor(s.status)} />
          </Link>
        ))}
        {servers.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>
            <Link href="/servers/new" style={{ color: "var(--c-a)" }}>{t("dashboard.addServer")}</Link>
          </div>
        )}
      </div>
    </div>
  );
}

const chip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600,
  color: "var(--c-a)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)",
  padding: "5px 11px", textDecoration: "none",
};
