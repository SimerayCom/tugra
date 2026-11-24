"use client";

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "../../../lib/api";
import { clientTeams } from "../../../lib/portal";
import { statusLabel } from "../../../lib/status";
import { monitorColor } from "../../../lib/monitors";
import type { Application, Backup, Database, Monitor, Team } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { useConfirm } from "../../../components/confirm";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { PageTitle } from "../../../components/page-header";

/**
 * The customer portal: what a Client of a team sees and nothing more. Apps, uptime and backups of each team the
 * caller is a Client of, plus a Deploy button when the role allows it. Every query here is on the hub's portal
 * surface; the hub (not this page) enforces that nothing else is reachable.
 */
export default function PortalPage() {
  const t = useT();
  const { data: teams = [], isLoading } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const mine = clientTeams(teams);
  const { data: apps = [] } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps(), enabled: mine.length > 0 });
  const { data: monitors = [] } = useQuery({ queryKey: ["monitors"], queryFn: () => api.listMonitors(), enabled: mine.length > 0, refetchInterval: 30_000 });
  const { data: databases = [] } = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases(), enabled: mine.length > 0 });

  if (isLoading) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 900 }}>
      <PageTitle title={t("portal.title")} subtitle={t("portal.subtitleGeneric")} />
      {mine.length === 0 ? (
        <Card style={{ padding: 16 }}><EmptyState>{t("portal.empty")}</EmptyState></Card>
      ) : (
        mine.map((team) => (
          <TeamSection
            key={team.id}
            team={team}
            showName={mine.length > 1}
            apps={apps.filter((a) => a.teamId === team.id)}
            monitors={monitors.filter((m) => m.teamId === team.id)}
            databases={databases.filter((d) => d.teamId === team.id)}
          />
        ))
      )}
    </div>
  );
}

function Section({ title, empty, isEmpty, children }: { title: string; empty: string; isEmpty: boolean; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" }}>{title}</h2>
      {isEmpty ? <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{empty}</p> : <Card style={{ padding: 0 }}><ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{children}</ul></Card>}
    </section>
  );
}

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 16px" };

function TeamSection({ team, showName, apps, monitors, databases }: { team: Team; showName: boolean; apps: Application[]; monitors: Monitor[]; databases: Database[] }) {
  const t = useT();
  const canDeploy = team.clientAccess === "deploy";
  return (
    <div style={{ marginBottom: 28 }}>
      {showName && <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 12px" }}>{team.name}</h2>}
      <Section title={t("portal.apps")} empty={t("portal.noApps")} isEmpty={apps.length === 0}>
        {apps.map((a, i) => <AppRow key={a.id} app={a} canDeploy={canDeploy} first={i === 0} />)}
      </Section>
      <Section title={t("portal.uptime")} empty={t("portal.noMonitors")} isEmpty={monitors.length === 0}>
        {monitors.map((m, i) => <MonitorRow key={m.id} monitor={m} first={i === 0} />)}
      </Section>
      <Section title={t("portal.backups")} empty={t("portal.noBackups")} isEmpty={databases.length === 0}>
        {databases.map((d, i) => <BackupRow key={d.id} db={d} first={i === 0} />)}
      </Section>
    </div>
  );
}

function AppRow({ app, canDeploy, first }: { app: Application; canDeploy: boolean; first: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const deploy = useMutation({
    mutationFn: () => api.deployApp(app.id),
    onSuccess: () => { toast(t("portal.deployStarted"), "success"); void qc.invalidateQueries({ queryKey: ["apps"] }); },
    onError: () => toast(t("portal.deployFailed"), "error"),
  });
  return (
    <li style={{ ...row, borderTop: first ? "none" : "1px solid var(--c-bd)" }}>
      <span style={{ flex: "1 1 160px", minWidth: 0, fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{app.name}</span>
      <Badge tone={app.status === "RUNNING" ? "ok" : app.status === "FAILED" ? "danger" : "muted"}>{statusLabel(t, app.status)}</Badge>
      {app.url && (
        <a href={app.url} target="_blank" rel="noreferrer" className="tg-link" aria-label={`${t("portal.open")}: ${app.name}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          {t("portal.open")} <ExternalLink size={12} aria-hidden />
        </a>
      )}
      {canDeploy && (
        <Btn
          variant="ghost"
          loading={deploy.isPending}
          aria-label={`${t("portal.deploy")}: ${app.name}`}
          onClick={async () => { if (await confirm({ body: t("portal.deployConfirm", { name: app.name }) })) deploy.mutate(); }}
        >
          {t("portal.deploy")}
        </Btn>
      )}
    </li>
  );
}

function MonitorRow({ monitor, first }: { monitor: Monitor; first: boolean }) {
  const t = useT();
  const { data } = useQuery({ queryKey: ["monitorUptime", monitor.id], queryFn: () => api.getUptime(monitor.id), refetchInterval: 60_000 });
  return (
    <li style={{ ...row, borderTop: first ? "none" : "1px solid var(--c-bd)" }}>
      <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: monitorColor(monitor.status), flexShrink: 0 }} />
      <span style={{ flex: "1 1 160px", minWidth: 0, fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{monitor.name}</span>
      <Badge tone={monitor.status === "UP" ? "ok" : monitor.status === "DOWN" ? "danger" : "warn"}>{statusLabel(t, monitor.status)}</Badge>
      <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{data && data.total > 0 ? t("portal.uptime24", { pct: data.percent }) : t("portal.noUptime")}</span>
    </li>
  );
}

function BackupRow({ db, first }: { db: Database; first: boolean }) {
  const t = useT();
  const q = useQuery({ queryKey: ["backups", db.id], queryFn: () => api.listBackups(db.id) });
  const list: Backup[] = q.data ?? [];
  const last = list.find((b) => b.status === "SUCCESS" || b.status === "FAILED");
  return (
    <li style={{ ...row, borderTop: first ? "none" : "1px solid var(--c-bd)" }}>
      <span style={{ flex: "1 1 160px", minWidth: 0, fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{db.name}</span>
      {last ? (
        last.status === "FAILED" ? (
          <Badge tone="danger">{t("portal.backupFailed")}</Badge>
        ) : (
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("portal.lastBackup", { time: new Date(last.completedAt ?? last.createdAt).toLocaleString() })}</span>
        )
      ) : (
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{q.isLoading ? "…" : t("portal.noBackups")}</span>
      )}
    </li>
  );
}
