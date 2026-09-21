"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Box, Database, FolderTree, Plus, ScrollText, Server, Settings } from "lucide-react";
import { api } from "../../../lib/api";
import { statusCounts, relativeTime } from "../../../lib/fleet";
import { fleetAttention } from "../../../lib/dashboard";
import { scopeByTeam } from "../../../lib/team-scope";
import { useTeamScope } from "../../../components/team-scope";
import type { ServerStatus } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, StatusPill } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { Skeleton, SkeletonCard, SkeletonStat, SkeletonTable } from "../../../components/skeleton";

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
  const { teamId } = useTeamScope();
  const { data: allServers = [], isLoading, isError: serversError, refetch: refetchServers } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: allProjects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: allApps = [] } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const { data: allDatabases = [] } = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases() });
  const { data: allMonitors = [] } = useQuery({ queryKey: ["monitors"], queryFn: () => api.listMonitors() });
  const { data: allDomains = [] } = useQuery({ queryKey: ["domains"], queryFn: () => api.listDomains() });
  const { data: audit } = useQuery({ queryKey: ["audit", teamId], queryFn: () => api.listAudit(teamId ?? undefined) });
  const servers = scopeByTeam(allServers, teamId);
  const projects = scopeByTeam(allProjects, teamId);
  const apps = scopeByTeam(allApps, teamId);
  const databases = scopeByTeam(allDatabases, teamId);
  const monitors = scopeByTeam(allMonitors, teamId);
  const domains = scopeByTeam(allDomains, teamId);
  const counts = statusCounts(servers);
  const attention = fleetAttention(servers, monitors, domains);
  const recent = audit?.entries.slice(0, 8) ?? [];
  // Servers is the dashboard's spine (fleet stats, attention, server list all derive
  // from it). When its fetch fails with nothing cached we can't claim "all normal" or
  // invite "Add server" — surface the error in the Servers section and neutralize the
  // counts instead of contradicting ourselves with a green banner next to a red error.
  const serversDown = serversError && allServers.length === 0;

  if (isLoading) {
    return (
      <div style={{ padding: "var(--page-pad)" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("dashboard.title")}</h1>
        <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("dashboard.subtitle")}</p>

        <div style={sectionTitle}>{t("dashboard.resources")}</div>
        <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
          <SkeletonStat /><SkeletonStat /><SkeletonStat /><SkeletonStat />
        </div>

        <div style={sectionTitle}>{t("dashboard.fleet")}</div>
        <div style={{ display: "flex", gap: 14, marginBottom: 28, flexWrap: "wrap" }}>
          <SkeletonStat /><SkeletonStat /><SkeletonStat />
        </div>

        <div style={sectionTitle}>{t("dashboard.attention")}</div>
        <div style={{ marginBottom: 28 }}>
          <SkeletonTable rows={2} />
        </div>

        <div style={sectionTitle}>{t("dashboard.projects")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, marginBottom: 28 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Skeleton width={40} height={40} radius={9} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Skeleton height={14} width="55%" style={{ marginBottom: 8 }} />
                  <Skeleton height={18} width="80%" />
                </div>
              </div>
            </SkeletonCard>
          ))}
        </div>

        <div style={sectionTitle}>{t("dashboard.servers")}</div>
        <SkeletonTable rows={4} />

        <div style={{ ...sectionTitle, marginTop: 28 }}>{t("dashboard.recentActivity")}</div>
        <SkeletonTable rows={5} />
      </div>
    );
  }

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
        {resource("/servers", Server, t("dashboard.totalServers"), isLoading ? "…" : serversDown ? "—" : servers.length)}
      </div>

      <div style={sectionTitle}>{t("dashboard.fleet")}</div>
      <div style={{ display: "flex", gap: 14, marginBottom: 28, flexWrap: "wrap" }}>
        {stat(t("dashboard.online"), serversDown ? "—" : counts.ONLINE, "var(--c-g)")}
        {stat(t("dashboard.pending"), serversDown ? "—" : counts.PENDING, "var(--c-am)")}
        {stat(t("dashboard.offline"), serversDown ? "—" : counts.OFFLINE, "var(--c-r)")}
      </div>

      <div style={sectionTitle}>{t("dashboard.attention")}</div>
      {attention.length === 0 ? (
        serversDown ? null : (
        <Card style={{ padding: 14, marginBottom: 28, fontSize: 13, color: "var(--c-tx2)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-g)" }} /> {t("dashboard.allGood")}
        </Card>
        )
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden", marginBottom: 28 }}>
          {attention.map((it) => {
            const href = it.kind === "server" ? `/servers/${it.id}` : it.kind === "monitor" ? `/monitors/${it.id}` : `/apps/${it.id}`;
            const amber = it.kind === "domain" && it.status === "expiring";
            const color = amber ? "var(--c-am)" : "var(--c-r)";
            const label = it.kind === "server" ? t("dashboard.attentionServer") : it.kind === "monitor" ? t("dashboard.attentionMonitor") : amber ? t("dashboard.attentionSslExpiring") : t("dashboard.attentionSslError");
            return (
              <Link key={`${it.kind}-${it.id}`} href={href} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
                <AlertTriangle size={15} color={color} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{it.name}</div>
                  <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{label}</div>
                </div>
                <span style={{ fontSize: 12, color, fontWeight: 600 }}>{it.status}</span>
              </Link>
            );
          })}
        </div>
      )}

      {/* Projects (Coolify-style cards with quick actions) */}
      <div style={sectionTitle}>{t("dashboard.projects")}</div>
      {projects.length === 0 ? (
        <Card style={{ marginBottom: 28 }}>
          <EmptyState
            icon={FolderTree}
            title={t("dashboard.noProjectsTitle")}
            action={<Link href="/projects"><Btn>{t("projects.create")}</Btn></Link>}
          >
            {t("dashboard.noProjects")}
          </EmptyState>
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
        {serversDown ? (
          <ErrorState onRetry={() => refetchServers()} />
        ) : servers.length === 0 && (
          <EmptyState
            icon={Server}
            title={t("dashboard.noServersTitle")}
            action={<Link href="/servers/new"><Btn>{t("dashboard.addServer")}</Btn></Link>}
          >
            {t("dashboard.noServers")}
          </EmptyState>
        )}
      </div>

      <div style={{ ...sectionTitle, marginTop: 28, display: "flex", alignItems: "center", gap: 8 }}>
        {t("dashboard.recentActivity")}
        <div style={{ flex: 1 }} />
        <Link href="/audit" style={{ fontSize: 11, color: "var(--c-lapis)", textTransform: "none", letterSpacing: 0, fontWeight: 500, textDecoration: "none" }}>{t("dashboard.viewAll")}</Link>
      </div>
      {recent.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("dashboard.noActivity")}</div>
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {recent.map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderTop: "1px solid var(--c-bd)", fontSize: 13 }}>
              <ScrollText size={13} color="var(--c-tx3)" style={{ flexShrink: 0 }} />
              <span style={{ color: "var(--c-tx2)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.actor}</span>
              <code style={{ fontSize: 12, color: "var(--c-tx3)" }}>{e.action}</code>
              <div style={{ flex: 1 }} />
              <span style={{ color: "var(--c-tx3)", fontSize: 11, whiteSpace: "nowrap" }}>{relativeTime(e.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const chip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600,
  color: "var(--c-a)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)",
  padding: "5px 11px", textDecoration: "none",
};
