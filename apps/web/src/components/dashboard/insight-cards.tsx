"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, DatabaseBackup, HardDrive, Rocket, ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { fmtBytes, formatUptime, relativeTime } from "../../lib/fleet";
import { formatDuration } from "../../lib/backups";
import { LIST_LIMIT, limitRows } from "../../lib/dashboard-lists";
import { CERT_WARN_DAYS, certsExpiringSoon, migrationDigest, outdatedAgents, uptimeSummary } from "../../lib/dashboard-health";
import type { DashboardBackupRow, DashboardDeployRow, DomainView, Monitor, ServerView } from "../../lib/types";
import { useT } from "../../i18n/provider";
import { Btn, StatusPill } from "../ui";
import { ListCard, ListRow } from "../list";
import { ErrorState } from "../error-state";
import { Skeleton } from "../skeleton";
import { CardLink, CardNote, DashCard, SeeAll } from "./dash-card";

const rowPad: CSSProperties = { padding: "10px 16px", gap: 10 };
const sub: CSSProperties = { fontSize: 11, color: "var(--c-tx3)" };
const grow: CSSProperties = { flex: 1, minWidth: 0 };
const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/** The shared digest query (disk forecast, backups, deploys). Cards that need it call this; the key is shared so
 *  the three cards cost one request, and a hidden card never fires it. */
export function useDashboardInsights(teamId: string | null) {
  return useQuery({ queryKey: ["dashboardInsights", teamId], queryFn: () => api.getDashboardInsights(teamId ?? undefined), refetchInterval: 60_000 });
}

function CardBody({ q, children }: { q: { isLoading: boolean; isError: boolean; data: unknown; refetch: () => unknown }; children: ReactNode }) {
  if (q.isLoading) return <Skeleton height={64} />;
  if (q.isError && !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  return <>{children}</>;
}

// ── Disk forecast ────────────────────────────────────────────────────────────────────────────────

export function DiskForecastCard({ teamId }: { teamId: string | null }) {
  const t = useT();
  const q = useDashboardInsights(teamId);
  const rows = q.data?.diskForecast ?? [];
  const { shown, total } = limitRows(rows);
  const first = rows.find((r) => r.daysToFull !== null);
  const anyKnown = rows.some((r) => r.growthBytesPerDay !== null);
  const lead = !first ? (anyKnown ? t("dashboard.diskNoForecast") : t("dashboard.diskCollecting"))
    : first.daysToFull === 0 ? t("dashboard.diskFullToday", { name: first.serverName })
    : t("dashboard.diskFullIn", { name: first.serverName, n: Math.max(1, Math.round(first.daysToFull as number)) });
  return (
    <DashCard id="diskForecast" title={t("dashboard.card.diskForecast")} right={<SeeAll href="/fleet" total={total} shown={shown.length} />}>
      <CardBody q={q}>
        {rows.length === 0 ? (
          <CardNote>{t("dashboard.diskCollecting")}</CardNote>
        ) : (
          <>
            <div role="status" style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px", color: first ? ((first.daysToFull as number) <= 14 ? "var(--c-r)" : "var(--c-am)") : "var(--c-tx2)", display: "flex", alignItems: "center", gap: 6 }}>
              {first && <AlertTriangle size={14} aria-hidden />}{lead}
            </div>
            <ListCard>
              {shown.map((r, i) => (
                <ListRow key={r.serverId} index={i} href={`/servers/${r.serverId}`} style={rowPad}>
                  <HardDrive size={15} color="var(--c-tx3)" aria-hidden style={{ flexShrink: 0 }} />
                  <div style={grow}>
                    <div style={{ fontWeight: 600, fontSize: 13, ...ellipsis }}>{r.serverName}</div>
                    <div style={sub}>
                      {t("dashboard.diskRow", { pct: Math.round(r.usedPct), free: fmtBytes(r.freeBytes) })}
                      {r.growthBytesPerDay !== null && r.growthBytesPerDay > 0 ? ` · ${t("dashboard.diskGrowth", { rate: fmtBytes(r.growthBytesPerDay) })}` : ""}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: r.daysToFull !== null ? (r.daysToFull <= 14 ? "var(--c-r)" : "var(--c-am)") : "var(--c-tx3)", whiteSpace: "nowrap" }}>
                    {r.daysToFull === null ? "—" : r.daysToFull === 0 ? t("dashboard.diskFullToday", { name: "" }).trim() : `~${Math.max(1, Math.round(r.daysToFull))}d`}
                  </span>
                </ListRow>
              ))}
            </ListCard>
          </>
        )}
      </CardBody>
    </DashCard>
  );
}

// ── Certificates ─────────────────────────────────────────────────────────────────────────────────

export function CertsCard({ domains }: { domains: DomainView[] }) {
  const t = useT();
  const rows = certsExpiringSoon(domains);
  const { shown, total } = limitRows(rows);
  return (
    <DashCard id="certs" title={t("dashboard.card.certs")} right={<SeeAll href="/domains" total={total} shown={shown.length} />}>
      {rows.length === 0 ? (
        <CardNote><ShieldCheck size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6, color: "var(--c-g)" }} />{t("dashboard.certsEmpty", { n: CERT_WARN_DAYS })}</CardNote>
      ) : (
        <ListCard>
          {shown.map((c, i) => {
            const bad = c.state === "error" || (c.daysRemaining !== null && c.daysRemaining <= 7);
            const text = c.state === "error" ? t("dashboard.certError")
              : c.daysRemaining === null ? t("domains.expiring")
              : c.daysRemaining <= 0 ? t("dashboard.certExpiredToday")
              : c.daysRemaining === 1 ? t("dashboard.certDaysLeftOne")
              : t("dashboard.certDaysLeft", { n: c.daysRemaining });
            return (
              <ListRow key={`${c.appId}-${c.domain}`} index={i} href={`/apps/${c.appId}`} style={rowPad}>
                <ShieldCheck size={15} color={bad ? "var(--c-r)" : "var(--c-am)"} aria-hidden style={{ flexShrink: 0 }} />
                <div style={{ ...grow, fontWeight: 600, fontSize: 13, ...ellipsis }}>{c.domain}</div>
                <span style={{ fontSize: 12, fontWeight: 600, color: bad ? "var(--c-r)" : "var(--c-am)", whiteSpace: "nowrap" }}>{text}</span>
              </ListRow>
            );
          })}
        </ListCard>
      )}
    </DashCard>
  );
}

// ── Backups ──────────────────────────────────────────────────────────────────────────────────────

const backupColor = (s: DashboardBackupRow["status"]) => (s === "FAILED" ? "var(--c-r)" : s === "SUCCESS" ? "var(--c-g)" : "var(--c-am)");

export function BackupsCard({ teamId }: { teamId: string | null }) {
  const t = useT();
  const q = useDashboardInsights(teamId);
  const b = q.data?.backups;
  const rows = b?.recent ?? [];
  const label = (s: DashboardBackupRow["status"]) => (s === "FAILED" ? t("dashboard.backupFailed") : s === "SUCCESS" ? t("dashboard.backupOk") : t("dashboard.backupRunning"));
  return (
    <DashCard id="backups" title={t("dashboard.card.backups")} right={b ? <SeeAll href="/databases" total={b.ok + b.failed + b.running} shown={rows.length} /> : null}>
      <CardBody q={q}>
        {!b || rows.length === 0 ? (
          <CardNote>{t("dashboard.backupsEmpty", { days: b?.windowDays ?? 7 })}</CardNote>
        ) : (
          <>
            <div role="status" style={{ fontSize: 12, color: b.failed > 0 ? "var(--c-r)" : "var(--c-tx2)", fontWeight: b.failed > 0 ? 600 : 400, margin: "0 0 8px" }}>
              {t("dashboard.backupsSummary", { ok: b.ok, failed: b.failed, days: b.windowDays })}
            </div>
            <ListCard>
              {rows.map((r, i) => (
                <ListRow key={`${r.kind}-${r.id}`} index={i} href={r.kind === "database" ? `/databases/${r.resourceId}` : `/apps/${r.resourceId}`} style={rowPad}>
                  <DatabaseBackup size={15} color="var(--c-tx3)" aria-hidden style={{ flexShrink: 0 }} />
                  <div style={grow}>
                    <div style={{ fontWeight: 600, fontSize: 13, ...ellipsis }}>{r.resourceName}</div>
                    <div style={sub}>{r.kind === "database" ? t("dashboard.backupDatabase") : t("dashboard.backupVolume")} · {relativeTime(r.createdAt)}{r.sizeBytes ? ` · ${fmtBytes(r.sizeBytes)}` : ""}</div>
                  </div>
                  <StatusPill label={label(r.status)} color={backupColor(r.status)} />
                </ListRow>
              ))}
            </ListCard>
          </>
        )}
      </CardBody>
    </DashCard>
  );
}

// ── Pending updates ──────────────────────────────────────────────────────────────────────────────

export function UpdatesCard({ servers }: { servers: ServerView[] }) {
  const t = useT();
  const { data: version } = useQuery({ queryKey: ["instanceVersion"], queryFn: () => api.getInstanceVersion(), staleTime: 5 * 60_000 });
  const behind = outdatedAgents(servers, version?.current);
  const { shown, total } = limitRows(behind);
  const os = useMutation({ mutationFn: (ids: string[]) => api.bulkCheckUpdates(ids) });
  const onlineIds = servers.filter((s) => s.status === "ONLINE").map((s) => s.id);
  const withUpdates = os.data?.results.filter((r) => r.online && r.updates && !r.updates.checkFailed && r.updates.count > 0).length ?? 0;
  const failed = os.isError || (os.data?.results.some((r) => r.online && (r.error || r.updates?.checkFailed)) ?? false);
  const osText = os.isPending ? t("dashboard.updatesOsChecking")
    : os.data ? (withUpdates > 0 ? (withUpdates === 1 ? t("dashboard.updatesOsSomeOne") : t("dashboard.updatesOsSome", { n: withUpdates })) : failed ? t("dashboard.updatesOsFailed") : t("dashboard.updatesOsNone"))
    : os.isError ? t("dashboard.updatesOsFailed")
    : t("dashboard.updatesOsUnchecked");
  return (
    <DashCard id="updates" title={t("dashboard.card.updates")} right={<SeeAll href="/servers" total={total} shown={shown.length} />}>
      <div role="status" style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px", color: behind.length ? "var(--c-am)" : "var(--c-tx2)" }}>
        {behind.length === 0 ? t("dashboard.updatesAgentsCurrent") : behind.length === 1 ? t("dashboard.updatesAgentsOne") : t("dashboard.updatesAgents", { n: behind.length })}
      </div>
      {shown.length > 0 && (
        <ListCard style={{ marginBottom: 10 }}>
          {shown.map((s, i) => (
            <ListRow key={s.id} index={i} href={`/servers/${s.id}`} style={rowPad}>
              <div style={{ ...grow, fontWeight: 600, fontSize: 13, ...ellipsis }}>{s.name}</div>
              <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{s.agentVersion}</span>
            </ListRow>
          ))}
        </ListCard>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", padding: "10px 16px" }}>
        <div style={grow}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t("dashboard.updatesOs")}</div>
          <div role="status" style={{ ...sub, color: withUpdates > 0 || failed ? "var(--c-am)" : "var(--c-tx3)" }}>{osText}</div>
        </div>
        <Btn variant="ghost" disabled={onlineIds.length === 0} loading={os.isPending} onClick={() => os.mutate(onlineIds)}>{t("dashboard.updatesOsCheck")}</Btn>
      </div>
    </DashCard>
  );
}

// ── Uptime ───────────────────────────────────────────────────────────────────────────────────────

export function UptimeCard({ servers, monitors }: { servers: ServerView[]; monitors: Monitor[] }) {
  const t = useT();
  const u = uptimeSummary(servers, monitors);
  const stat = (value: ReactNode, label: string, tone?: string) => (
    <div style={{ flex: "1 1 160px", minWidth: 0 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone ?? "var(--c-tx)" }}>{value}</div>
      <div style={sub}>{label}</div>
    </div>
  );
  return (
    <DashCard id="uptime" title={t("dashboard.card.uptime")} right={<CardLink href="/monitors">{t("dashboard.viewAll")}</CardLink>}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", padding: "14px 16px" }}>
        {u.monitorsTotal > 0
          ? stat(`${u.monitorsUp}/${u.monitorsTotal}`, t("dashboard.uptimeMonitors", { up: u.monitorsUp, total: u.monitorsTotal }), u.monitorsDown > 0 ? "var(--c-r)" : "var(--c-g)")
          : stat("—", t("dashboard.uptimeNoMonitors"))}
        {stat(`${u.serversOnline}/${u.serversTotal}`, t("dashboard.uptimeServers", { online: u.serversOnline, total: u.serversTotal }), u.serversTotal > u.serversOnline ? "var(--c-am)" : "var(--c-g)")}
        {u.longestUptimeSec !== null && stat(formatUptime(u.longestUptimeSec), t("dashboard.uptimeLongest", { value: formatUptime(u.longestUptimeSec) }))}
      </div>
    </DashCard>
  );
}

// ── Recent deploys ───────────────────────────────────────────────────────────────────────────────

const deployColor = (s: DashboardDeployRow["status"]) => (s === "FAILED" ? "var(--c-r)" : s === "SUCCESS" ? "var(--c-g)" : s === "CANCELLED" ? "var(--c-tx3)" : "var(--c-am)");

export function DeploysCard({ teamId }: { teamId: string | null }) {
  const t = useT();
  const q = useDashboardInsights(teamId);
  const rows = q.data?.deploys ?? [];
  const { shown, total } = limitRows(rows);
  return (
    <DashCard id="deploys" title={t("dashboard.card.deploys")} right={<SeeAll href="/apps" total={total} shown={shown.length} />}>
      <CardBody q={q}>
        {rows.length === 0 ? (
          <CardNote>{t("dashboard.deploysEmpty")}</CardNote>
        ) : (
          <ListCard>
            {shown.map((d, i) => (
              <ListRow key={d.id} index={i} href={`/apps/${d.appId}`} style={rowPad}>
                <Rocket size={15} color="var(--c-tx3)" aria-hidden style={{ flexShrink: 0 }} />
                <div style={grow}>
                  <div style={{ fontWeight: 600, fontSize: 13, ...ellipsis }}>{d.appName}</div>
                  <div style={sub}>{relativeTime(d.createdAt)}{d.durationMs != null ? ` · ${formatDuration(d.durationMs)}` : ""}</div>
                </div>
                <StatusPill label={t(`dashboard.deployStatus.${d.status}`)} color={deployColor(d.status)} />
              </ListRow>
            ))}
          </ListCard>
        )}
      </CardBody>
    </DashCard>
  );
}

// ── Migrations ───────────────────────────────────────────────────────────────────────────────────

export function MigrationsCard({ teamId }: { teamId: string | null }) {
  const t = useT();
  const q = useQuery({ queryKey: ["dashboardMigrations", teamId], queryFn: () => api.listMigrationRuns({ teamId, limit: 20 }), refetchInterval: 30_000 });
  const d = migrationDigest(q.data ?? []);
  const lines = [
    ...d.live.map((r) => ({ r, label: t("dashboard.migrationsLive"), color: "var(--c-am)" })),
    ...d.failed.slice(0, 2).map((r) => ({ r, label: t("dashboard.migrationsFailed"), color: "var(--c-r)" })),
    ...(d.lastDone ? [{ r: d.lastDone, label: t("dashboard.migrationsLastDone"), color: "var(--c-g)" }] : []),
  ];
  const { shown, total } = limitRows(lines);
  return (
    <DashCard id="migrations" title={t("dashboard.card.migrations")} right={<SeeAll href="/import/runs" total={total} shown={shown.length} />}>
      <CardBody q={q}>
        {lines.length === 0 ? (
          <CardNote>
            {t("dashboard.migrationsEmpty")} <Link href="/import" style={{ color: "var(--c-lapis)" }}>{t("dashboard.migrationsStart")}</Link>
          </CardNote>
        ) : (
          <ListCard>
            {shown.map(({ r, label, color }, i) => (
              <ListRow key={r.id} index={i} href={`/import/runs/${r.id}`} style={rowPad}>
                <div style={grow}>
                  <div style={{ fontWeight: 600, fontSize: 13, ...ellipsis }}>{r.sourceHost ?? r.sourceKind}{r.targetServerName ? ` → ${r.targetServerName}` : ""}</div>
                  <div style={sub}>{label} · {r.stepsPassed}/{r.stepsTotal} · {relativeTime(r.finishedAt ?? r.startedAt ?? r.createdAt)}</div>
                </div>
                <StatusPill label={t(`migrationRun.status.${r.status}`)} color={color} />
              </ListRow>
            ))}
          </ListCard>
        )}
      </CardBody>
    </DashCard>
  );
}
