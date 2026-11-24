"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { TriangleAlert, RefreshCw, LayoutDashboard, Activity, Boxes, PackageCheck, Waypoints, Wrench, Terminal, Plus, Play, RotateCw, Square, ScrollText, Pencil } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { filterAudit } from "../../../../lib/audit";
import { ErrorState } from "../../../../components/error-state";
import { installPhase } from "../../../../lib/server-install";
import { useTabState } from "../../../../hooks/useTabState";
import { CopyBtn } from "../../../../components/copy-row";
import { InstallTransportNote } from "../../../../components/install-transport-note";
import { useConfirm } from "../../../../components/confirm";
import { pct, fmtBytesStr, formatUptime } from "../../../../lib/fleet";
import { diskPctSeries, humanizeRatePair } from "../../../../lib/metrics";
import type { MetricsRange, PatchInfo, ServerStatus, ServerView, AgentUpdateResponse } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { MetricChart, METRIC_GRID_STYLE, METRIC_CHART_HEIGHT } from "../../../../components/charts";
import { ServerContainersCard } from "../../../../components/server-containers-card";
import { ServerRebootCard } from "../../../../components/server-reboot-card";
import { ServerOobCard } from "../../../../components/server-oob-card";
import { LiveGauges } from "../../../../components/live-gauges";
import { GpuCard } from "../../../../components/gpu-card";
import { DiscoverAdoptCard } from "../../../../components/discover-adopt-card";
import { Modal } from "../../../../components/modal";
import { fieldStyle, useSaveFeedback } from "../../../../components/form";
import { TerminalPanel } from "../../../../components/terminal-panel";
import { RenameModal } from "../../../../components/rename-modal";
import { TagsCard } from "../../../../components/tags";
import { LogDrainCard } from "../../../../components/log-drains/log-drain-card";
import { CapabilitiesCard } from "../../../../components/server-capabilities-card";
import { ServerTeamCard } from "../../../../components/server-team-card";
import { AcmeDnsCredentialPicker } from "../../../../components/acme-dns-credential-picker";
import { useToast } from "../../../../components/toast";
import { TrafficAnalyticsCard } from "../../../../components/traffic-analytics-card";
import { Badge, Btn, Card, EmptyState, SectionCard, Spinner, StatusPill } from "../../../../components/ui";
import { Skeleton, SkeletonCard } from "../../../../components/skeleton";
import type { ProxyStatus } from "../../../../lib/types";
import { PageHeader } from "../../../../components/page-header";
import { Tabs } from "../../../../components/tabs-nav";
import { RuntimeUpdateWarning } from "../../../../components/runtime-update-warning";
import { containerRuntimeUpdates, interruptedNames, isAgentDropError, isTransientPatchError, patchTiming, phasedToastKey, settledApplyLog, shouldToastReboot, summarizeApply } from "../../../../lib/patching";
import { usePatchLogStream } from "../../../../hooks/useDeployLogStream";
import { useMetricsStream } from "../../../../hooks/useMetricsStream";
import { useServerReconnect } from "../../../../hooks/useServerReconnect";
import { useStickToBottom } from "../../../../hooks/useStickToBottom";

const serverColor = (s: ServerStatus) =>
  s === "ONLINE" ? "var(--c-g)" : s === "PENDING" ? "var(--c-am)" : "var(--c-r)";

export default function ServerDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();

  const { data: server, isLoading, isError, refetch } = useQuery({
    queryKey: ["server", id],
    queryFn: () => api.getServer(id),
    refetchInterval: 5000,
  });
  const tags = useMutation({
    mutationFn: (next: string[]) => api.setServerTags(id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["server", id] }),
  });
  // Monitoring range: "live" = last-60 + SSE append; 1h/6h/24h/7d = server-side history (raw ≤2h,
  // 1-minute rollups beyond) with no live append.
  const [range, setRange] = useState<"live" | MetricsRange>("live");
  const live = range === "live";
  const { data: metrics = [] } = useQuery({
    queryKey: live ? ["metrics", id] : ["metrics", id, range],
    queryFn: () => (live ? api.getMetrics(id, 60) : api.getServerMetricsRange(id, range as MetricsRange)),
    refetchInterval: live ? 30000 : false, // live: slow heal/fallback (SSE below); history: static
  });
  const [renaming, setRenaming] = useState(false);
  const rename = useMutation({
    mutationFn: (name: string) => api.renameServer(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["server", id] });
      qc.invalidateQueries({ queryKey: ["servers"] });
      setRenaming(false);
    },
  });
  const tabDefs = [
    { key: "overview", label: t("servers.tabOverview"), icon: LayoutDashboard },
    { key: "monitoring", label: t("servers.tabMonitoring"), icon: Activity },
    { key: "containers", label: t("servers.tabContainers"), icon: Boxes },
    ...(server?.canWrite ? [{ key: "updates", label: t("servers.tabUpdates"), icon: PackageCheck }, { key: "drains", label: t("servers.tabDrains"), icon: Waypoints }, { key: "shell", label: t("servers.tabShell"), icon: Terminal }] : []),
    { key: "maintenance", label: t("servers.tabMaintenance"), icon: Wrench },
    { key: "activity", label: t("servers.tabActivity"), icon: ScrollText },
  ];
  const [tab, setTab] = useTabState("overview", tabDefs.map((d) => d.key));
  // Push live samples into the metrics cache while the overview gauges or the live monitoring charts
  // are on screen (both read ["metrics", id]). The overview gauges are always live, so the stream runs
  // there regardless of the monitoring range; on the monitoring tab it only runs in live mode, since
  // appending SSE to a historical range would corrupt it.
  useMetricsStream(id, tab === "overview" || (tab === "monitoring" && live));

  // Celebrate the PENDING → ONLINE moment with a forward CTA (no dead-end).
  const prevStatus = useRef<ServerStatus | null>(null);
  const [enrolled, setEnrolled] = useState(false);
  useEffect(() => {
    if (prevStatus.current === "PENDING" && server?.status === "ONLINE") setEnrolled(true);
    if (server) prevStatus.current = server.status;
  }, [server?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Agent came back (any non-ONLINE → ONLINE): the Maintenance/Updates/Proxy cards are one-shot queries that
  // loaded or errored while it was down and never refetch on their own — re-pull everything keyed to this
  // server on the status edge so the panel recovers WITHOUT a manual refresh.
  useServerReconnect(id, server?.status);

  if (isError && !server) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !server) return <ServerDetailSkeleton />;

  const times = metrics.map((m) => m.ts);
  const cpu = metrics.map((m) => m.cpu);
  // 7d/30d rollup points carry the stored per-minute peak → a faint max band behind the average line.
  const cpuPeaks = metrics.some((m) => m.cpuMax !== undefined) ? metrics.map((m) => m.cpuMax ?? m.cpu) : undefined;
  const disk = diskPctSeries(metrics); // disk % history from the stored diskUsed/diskTotal (own time axis)
  const ram = metrics.map((m) => pct(m.memUsed, m.memTotal));
  const net = humanizeRatePair(metrics.map((m) => m.netRx), metrics.map((m) => m.netTx));
  // `?? 0`: an older agent's live SSE sample omits diskRead/diskWrite (undefined) — default it so the
  // rate humanizer picks the right unit and the chart never sees a non-finite value.
  const dio = humanizeRatePair(metrics.map((m) => m.diskRead ?? 0), metrics.map((m) => m.diskWrite ?? 0));

  // Load average (1/5/15 min) + swap are optional: older agents omit them, so a missing point is NaN ("no data"
  // → a gap in the line, and an entirely-absent series is dropped). The Load chart only renders when at least
  // one point exists; the Swap chart only when the host has swap (swapTotal > 0).
  const num = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const load1 = metrics.map((m) => num(m.load1));
  const load5 = metrics.map((m) => num(m.load5));
  const load15 = metrics.map((m) => num(m.load15));
  const hasLoad = [load1, load5, load15].some((s) => s.some((v) => Number.isFinite(v)));
  const swap = metrics.map((m) => (typeof m.swapTotal === "number" && m.swapTotal > 0 && Number.isFinite(m.swapUsed) ? pct(m.swapUsed as number, m.swapTotal) : NaN));
  const hasSwap = swap.some((v) => Number.isFinite(v));

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={[{ label: t("nav.servers"), href: "/servers" }, { label: server.name }]}
        title={server.name}
        status={{ label: server.status, color: serverColor(server.status) }}
        badge={!server.canWrite ? <Badge tone="muted">{t("servers.readOnly")}</Badge> : undefined}
        actions={server.canWrite ? (
          <>
            <Link href={`/resources/new?server=${id}`}><Btn icon={Plus}>{t("servers.addResource")}</Btn></Link>
            <Btn icon={Terminal} variant="ghost" onClick={() => setTab("shell")}>{t("servers.openHostShell")}</Btn>
            <Btn icon={Pencil} variant="ghost" onClick={() => setRenaming(true)}>{t("servers.rename")}</Btn>
          </>
        ) : undefined}
      >
        <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: 0 }}>{server.hostname ?? "—"}</p>
      </PageHeader>

      {enrolled && (
        <Card style={{ padding: 14, marginBottom: 20, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderColor: "var(--c-g)" }}>
          <span style={{ fontWeight: 600 }}>{t("servers.enrolledTitle")}</span>
          <div style={{ flex: 1 }} />
          <Link href={`/resources/new?server=${id}&kind=app`}><Btn>{t("servers.addFirstApp")}</Btn></Link>
          <Btn variant="ghost" onClick={() => setEnrolled(false)}>{t("common.cancel")}</Btn>
        </Card>
      )}

      {server.status === "PENDING" ? (
        server.canWrite ? (
          <ServerInstallCard id={id} />
        ) : (
          <Card style={{ padding: 16, display: "flex", alignItems: "center", gap: 10 }}>
            <Spinner /><span style={{ color: "var(--c-tx3)" }}>{t("servers.waiting")}</span>
          </Card>
        )
      ) : (
      <>
      <Tabs active={tab} onChange={setTab} tabs={tabDefs} />

      {tab === "overview" && (
        <>
          <LiveGauges id={id} nowMs={Date.now()} canWrite={server.canWrite} onOpenMaintenance={() => setTab("maintenance")} />
          <Card style={{ padding: 16, marginBottom: 20, display: "flex", gap: 28, flexWrap: "wrap" }}>
            <Info label={t("servers.status")} value={server.status} />
            <Info label={t("servers.ipAddress")} value={server.publicIp ?? server.publicIpv6 ?? "—"} />
            <Info label={t("servers.team")} value={server.teamId.slice(0, 8)} />
            <Info label={t("servers.sealLabel")} value={server.seal ? t("servers.sealed") : "—"} />
            <Info label={t("servers.lastSeen")} value={server.lastSeenAt ? new Date(server.lastSeenAt).toLocaleTimeString() : "—"} />
            {server.clusterId && (
              <Info
                label={t("servers.cluster")}
                value={
                  <Link href={`/clusters/${server.clusterId}`} style={{ color: "var(--c-a)", textDecoration: "none" }}>
                    {server.clusterName ?? server.clusterId}
                  </Link>
                }
              />
            )}
          </Card>
          {(server.os || server.arch || server.cpuCores || server.agentVersion) && (
            <Card style={{ padding: 16, display: "flex", gap: 28, flexWrap: "wrap" }}>
              <Info label={t("servers.os")} value={server.os ? `${server.os} ${server.osVersion ?? ""}`.trim() : "—"} />
              <Info label={t("servers.arch")} value={server.arch ?? "—"} />
              <Info label={t("servers.kernel")} value={server.kernel ?? "—"} />
              <Info label={t("servers.agentVersion")} value={server.agentVersion ?? "—"} />
              <Info label={t("servers.cpuCores")} value={server.cpuCores != null ? String(server.cpuCores) : "—"} />
              <Info label={t("servers.ramTotal")} value={fmtBytesStr(server.memTotalBytes)} />
              <Info label={t("servers.uptime")} value={formatUptime(server.uptimeSeconds)} />
            </Card>
          )}
          <GpuCard serverId={id} canOps={server.canOps} online={server.status === "ONLINE"} />
        </>
      )}

      {tab === "monitoring" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["live", "1h", "6h", "24h", "7d", "30d"] as const).map((r) => (
              <Btn key={r} variant={r === range ? "primary" : "ghost"} onClick={() => setRange(r)}>
                {t(`servers.range${r === "live" ? "Live" : r}`)}
              </Btn>
            ))}
          </div>
          {metrics.length === 0 ? (
            <Card style={{ padding: 16 }}><EmptyState>{t("servers.noMetrics")}</EmptyState></Card>
          ) : (
            <div style={METRIC_GRID_STYLE}>
              <MetricChart height={METRIC_CHART_HEIGHT} data={cpu} peaks={cpuPeaks} times={times} label={t("servers.cpu")} unit="%" color="var(--c-a)" />
              <MetricChart height={METRIC_CHART_HEIGHT} data={ram} times={times} label={t("servers.ram")} unit="%" color="var(--c-lapis)" />
              <MetricChart height={METRIC_CHART_HEIGHT} data={disk.data} times={disk.times} label={t("servers.diskHistory")} unit="%" color="var(--c-g)" decimals={1} />
              {hasLoad && (
                <MetricChart
                  height={METRIC_CHART_HEIGHT}
                  times={times}
                  label={t("servers.loadAvg")}
                  unit=""
                  decimals={2}
                  series={[
                    { key: "load1", label: t("servers.load1"), values: load1, color: "var(--c-a)", kind: "line" },
                    { key: "load5", label: t("servers.load5"), values: load5, color: "var(--c-lapis)", kind: "line" },
                    { key: "load15", label: t("servers.load15"), values: load15, color: "var(--c-am)", kind: "line" },
                  ]}
                />
              )}
              {hasSwap && (
                <MetricChart
                  height={METRIC_CHART_HEIGHT}
                  times={times}
                  label={t("servers.swapHistory")}
                  unit="%"
                  decimals={1}
                  series={[{ key: "swap", label: t("servers.swap"), values: swap, color: "var(--c-g)", kind: "area" }]}
                />
              )}
              <MetricChart
                height={METRIC_CHART_HEIGHT}
                times={times}
                label={t("servers.net")}
                unit={" " + net.unit}
                decimals={1}
                series={[
                  { key: "in", label: t("servers.netIn"), values: net.a, color: "var(--c-g)", kind: "area" },
                  { key: "out", label: t("servers.netOut"), values: net.b, color: "var(--c-am)", kind: "area" },
                ]}
              />
              <MetricChart
                height={METRIC_CHART_HEIGHT}
                times={times}
                label={t("servers.diskIo")}
                unit={" " + dio.unit}
                decimals={1}
                series={[
                  { key: "read", label: t("servers.diskRead"), values: dio.a, color: "var(--c-lapis)", kind: "area" },
                  { key: "write", label: t("servers.diskWrite"), values: dio.b, color: "var(--c-am)", kind: "area" },
                ]}
              />
            </div>
          )}
        </div>
      )}

      {tab === "containers" && <ServerContainersCard id={id} canWrite={server.canWrite} />}

      {tab === "updates" && server.canWrite && (
        <>
          <AgentUpdateCard id={id} version={server.agentVersion} />
          <PatchCard
            id={id}
            onOpenReboot={() => {
              setTab("maintenance");
              // The card mounts with the tab: scroll to it once it is there.
              setTimeout(() => document.getElementById("server-reboot")?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 50);
            }}
          />
        </>
      )}

      {tab === "drains" && server.canWrite && <LogDrainCard scope={{ kind: "server", id }} />}

      {tab === "maintenance" && (
        <>
          <TagsCard tags={server.tags} canWrite={server.canWrite} onSave={(next) => tags.mutate(next)} />
          <ServerRebootCard id={id} serverName={server.name} canWrite={server.canWrite} />
          <ServerOobCard id={id} serverName={server.name} />
          <ProxyCard id={id} canWrite={server.canWrite} />
          <TrafficAnalyticsCard id={id} enabled={server.trafficAnalytics} canWrite={server.canWrite} />
          <ProxyDynamicCard id={id} canWrite={server.canWrite} />
          {server.canWrite && <NetworkCard id={id} server={server} />}
          <TunnelCard id={id} server={server} />
          {server.canWrite && <CapabilitiesCard id={id} server={server} />}
          {server.canWrite && <ServerDetailsCard id={id} server={server} />}
          {server.canWrite && <ServerTeamCard id={id} server={server} />}
          {server.canWrite && <CleanupCard id={id} server={server} />}
          {server.canWrite && <DiscoverAdoptCard id={id} />}
          {server.canWrite && <DeleteServerCard id={id} server={server} />}
        </>
      )}

      {tab === "activity" && <ServerAuditCard id={id} />}

      {tab === "shell" && server.canWrite && (
        <TerminalPanel
          target={{ server: id }}
          // Never blocked here: a PENDING server is handled by its own UI above, so this tab only sees
          // ONLINE/OFFLINE. On an OFFLINE blip we KEEP the xterm mounted and let its own auto-reconnect +
          // status badge ride it out — tearing it down on every 5s-poll OFFLINE would drop the live session
          // and scrollback on a brief drop.
          height={540}
        />
      )}
      </>
      )}

      {renaming && (
        <RenameModal
          current={server.name}
          title={t("servers.rename")}
          onClose={() => setRenaming(false)}
          onSave={(n) => rename.mutate(n)}
          pending={rename.isPending}
        />
      )}
    </div>
  );
}

/** Page-shaped shimmer shown while the server query is loading — mirrors header, tabs,
 * overview info card, and the monitoring charts grid so the skeleton→content swap doesn't jump. */
function ServerDetailSkeleton() {
  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ minWidth: 180 }}>
          <Skeleton height={11} width={130} style={{ marginBottom: 10 }} />
          <Skeleton height={24} width={200} style={{ marginBottom: 8 }} />
          <Skeleton height={13} width={140} />
        </div>
        <Skeleton height={32} width={130} />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} height={30} width={92} />
        ))}
      </div>

      <SkeletonCard style={{ marginBottom: 20, display: "flex", gap: 28, flexWrap: "wrap" }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i}>
            <Skeleton height={11} width={64} style={{ marginBottom: 8 }} />
            <Skeleton height={16} width={84} />
          </div>
        ))}
      </SkeletonCard>

      <div style={METRIC_GRID_STYLE}>
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i}>
            <Skeleton height={12} width={80} style={{ marginBottom: 12 }} />
            <Skeleton height={METRIC_CHART_HEIGHT} />
          </SkeletonCard>
        ))}
      </div>
    </div>
  );
}

function ServerInstallCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [waitedMs, setWaitedMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const iv = setInterval(() => setWaitedMs(Date.now() - start), 5000);
    return () => clearInterval(iv);
  }, []);

  const install = useQuery({
    queryKey: ["serverInstall", id],
    queryFn: () => api.getServerInstall(id),
    refetchInterval: 10000,
  });
  const reissue = useMutation({
    mutationFn: () => api.reissueServerEnroll(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["serverInstall", id] }),
  });

  if (install.isLoading) return <Card style={{ padding: 16 }}><Spinner /></Card>;

  const cmd = install.data?.installCommand ?? null;
  const phase = installPhase(cmd, waitedMs);

  return (
    <SectionCard title={t("servers.installTitle")} desc={t("servers.installDesc")}>

      {phase === "expired" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--c-am)" }}>{t("servers.tokenExpired")}</span>
          <Btn onClick={() => reissue.mutate()} disabled={reissue.isPending}>
            {reissue.isPending ? "…" : t("servers.getFreshCommand")}
          </Btn>
        </div>
      ) : (
        <>
          <pre className="mono" style={{ background: "var(--c-el)", padding: 12, borderRadius: "var(--r1)", fontSize: 12, overflowX: "auto", margin: 0 }}>{cmd}</pre>
          <div style={{ marginTop: 10 }}><CopyBtn text={cmd ?? ""} label={t("servers.copy")} /></div>
          <InstallTransportNote command={cmd} />

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
            <Spinner /><span style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("servers.waiting")}</span>
          </div>

          {phase === "troubleshoot" && (
            <div style={{ marginTop: 16, padding: 12, background: "var(--c-el)", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)" }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{t("servers.troubleshootTitle")}</div>
              <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0, lineHeight: 1.6 }}>{t("servers.troubleshootHint")}</p>
              <Btn variant="ghost" style={{ marginTop: 10 }} onClick={() => reissue.mutate()} disabled={reissue.isPending}>
                {reissue.isPending ? "…" : t("servers.getFreshCommand")}
              </Btn>
            </div>
          )}
        </>
      )}
      {reissue.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(reissue.error as Error).message}</div>}
    </SectionCard>
  );
}

// Signed, digest-pinned self-update of the Tugra Go agent. The hub picks the target from its ed25519-verified
// release manifest (the request can't name a version/image), so this is a safe one-click op; the new version
// shows in overview once the recreated agent reconnects.
const AGENT_RESTART_TIMEOUT_MS = 180_000;

function AgentUpdateCard({ id, version }: { id: string; version: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const buildMsg = (r: AgentUpdateResponse): { tone: "ok" | "warn" | "err"; text: string } => {
    if (r.status === "unconfigured") return { tone: "err", text: t("patching.agentUnconfigured") };
    if (r.status === "error") return { tone: "err", text: t("patching.agentError") };
    const item = r.results[0];
    if (!item) return { tone: "warn", text: t("patching.agentSkipped") };
    if (item.status === "sent") return { tone: "ok", text: t("patching.agentSent") };
    if (item.status === "offline") return { tone: "warn", text: t("patching.agentOffline") };
    const reasons: Record<string, string> = {
      "already-current": "patching.agentCurrentAlready",
      "no-digest-for-arch": "patching.agentNoDigest",
      "capability-not-granted": "patching.agentCapability",
      "not-permitted": "patching.agentNotPermitted",
    };
    return { tone: "warn", text: t(reasons[item.reason ?? ""] ?? "patching.agentSkipped") };
  };
  // After a dispatched update the agent restarts on the new image: remember the version it ran before and
  // keep the card in a "restarting" state until the polled server record reports a different one.
  const toast = useToast();
  const [restartingFrom, setRestartingFrom] = useState<{ version: string | null } | null>(null);
  const restarting = restartingFrom !== null;
  const update = useMutation({
    mutationFn: () => api.updateAgent(id),
    onSuccess: (r) => {
      setMsg(buildMsg(r));
      if (r.status === "ok" && r.results[0]?.status === "sent") setRestartingFrom({ version });
      qc.invalidateQueries({ queryKey: ["server", id] });
    },
    onError: (e) => setMsg({ tone: "err", text: (e as Error).message }),
  });
  useEffect(() => {
    if (restartingFrom && version && version !== restartingFrom.version) {
      toast(t("patching.agentUpdated", { version }), "success");
      setMsg(null);
      setRestartingFrom(null);
    }
  }, [version, restartingFrom, toast, t]);
  // Safety net: a dispatch that never changes the version (e.g. the pull failed) must not spin forever.
  useEffect(() => {
    if (!restartingFrom) return;
    const h = setTimeout(() => setRestartingFrom(null), AGENT_RESTART_TIMEOUT_MS);
    return () => clearTimeout(h);
  }, [restartingFrom]);
  const run = async () => {
    if (await confirm({ body: t("patching.agentConfirm") })) update.mutate();
  };
  const toneColor = msg?.tone === "ok" ? "var(--c-g)" : msg?.tone === "warn" ? "var(--c-am)" : "var(--c-r)";

  return (
    <SectionCard
      title={t("patching.agentTitle")}
      desc={t("patching.agentDesc")}
      style={{ marginTop: 20 }}
      right={
        <>
          <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "1px 6px" }}>{version ?? "—"}</span>
          <Btn variant="ghost" onClick={run} loading={update.isPending || restarting} disabled={update.isPending || restarting}>
            {update.isPending ? t("patching.agentUpdating") : restarting ? t("patching.agentRestarting") : t("patching.agentUpdate")}
          </Btn>
        </>
      }
    >
      {msg && <div style={{ fontSize: 13, color: toneColor }}>{msg.text}</div>}
      {restarting && <div role="status" style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 6 }}>{t("patching.agentRestartingHint")}</div>}
    </SectionCard>
  );
}

// This server's audit trail (every actor; membership-gated read). Reuses the global /audit shape but
// drops the Target column — every row targets this server — and keeps the client-side filter + load-more.
function ServerAuditCard({ id }: { id: string }) {
  const t = useT();
  const [q, setQ] = useState("");
  const { data, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["server-audit", id],
    queryFn: ({ pageParam }) => api.listServerAudit(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = data?.pages?.flatMap((p) => p.entries) ?? [];
  const shown = filterAudit(entries, q);
  const fmt = (iso: string) => new Date(iso).toLocaleString();

  if (isError && entries.length === 0) return <Card style={{ padding: 16, marginTop: 20 }}><ErrorState onRetry={() => refetch()} /></Card>;
  if (isLoading) return <Card style={{ padding: 16, marginTop: 20, display: "flex", justifyContent: "center" }}><Spinner /></Card>;

  return (
    <SectionCard
      title={t("audit.title")}
      desc={t("servers.activityDesc")}
      style={{ marginTop: 20 }}
      right={entries.length > 0 && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{shown.length}/{entries.length}</span>}
    >
      {entries.length === 0 ? (
        <EmptyState>{t("audit.empty")}</EmptyState>
      ) : (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("audit.search")}
            aria-label={t("audit.search")}
            style={{ ...fieldStyle, width: "100%", marginBottom: 12 }}
          />
          <div className="tg-tablewrap">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--c-tx3)" }}>
                  <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("audit.actor")}</th>
                  <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("audit.action")}</th>
                  <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("audit.time")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} style={{ borderTop: "1px solid var(--c-bd)" }}>
                    <td style={{ padding: "8px 10px", color: "var(--c-tx2)" }}>{e.actor}</td>
                    <td style={{ padding: "8px 10px" }}><code style={{ fontSize: 12 }}>{e.action}</code></td>
                    <td style={{ padding: "8px 10px", color: "var(--c-tx3)", whiteSpace: "nowrap" }}>{fmt(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)", padding: "10px 0" }}>{t("audit.noMatch")}</div>}
          {hasNextPage && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
              <Btn variant="ghost" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? "…" : t("audit.loadMore")}
              </Btn>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

type PatchPhase = "idle" | "applying" | "waiting" | "running" | "rechecking";

function PatchCard({ id, onOpenReboot }: { id: string; onOpenReboot: () => void }) {
  const t = useT();
  const confirm = useConfirm();
  const [output, setOutput] = useState("");
  const [applying, setApplying] = useState(false);
  const log = usePatchLogStream(id, applying);
  const streamedRef = useRef("");
  streamedRef.current = log.lines;
  const logText = applying ? log.lines : output;
  const logRef = useStickToBottom<HTMLPreElement>(logText); // follow the live apt output as it streams
  const toast = useToast();
  const [info, setInfo] = useState<PatchInfo | null>(null);
  // After an update the list is untrusted (packages it installed are still listed, a restarted agent can't answer)
  // until a fresh check lands: `stale` hides the rows and the reboot banner, `phase` says what we are waiting on.
  const [stale, setStale] = useState(false);
  const [phase, setPhase] = useState<PatchPhase>("idle");
  const [applyTarget, setApplyTarget] = useState<string | null>(null); // package name, or null for "update all"
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const check = useMutation({
    mutationFn: () => api.checkUpdates(id),
    onSuccess: (r) => { setInfo(r); setStale(false); },
  });
  const busy = phase !== "idle";

  // Re-run the check after an update until it answers. A 4xx is a definitive error (stop); anything transient —
  // the agent reconnecting after the update restarted Docker, a hub timeout, a network blip — is retried until the
  // deadline. The update itself runs on the host and outlives all of that (even a hub restart), so an answer that
  // says it is STILL RUNNING is not an answer either: keep waiting (longer deadline) until it has finished.
  // Resolves null when it never got a trustworthy answer or the card unmounted.
  const recheck = async (waitFirst: boolean): Promise<PatchInfo | null> => {
    const started = Date.now();
    let lastAnswer = started; // the transient-error deadline counts from the last time the server answered
    let first = !waitFirst;
    for (;;) {
      if (!first) await new Promise((r) => setTimeout(r, patchTiming.intervalMs));
      first = false;
      if (!alive.current) return null;
      try {
        const r = await api.checkUpdates(id);
        lastAnswer = Date.now();
        if (!r.applyRunning) return r;
        if (Date.now() - started >= patchTiming.runningDeadlineMs) return null;
        if (alive.current) setPhase("running");
      } catch (e) {
        if (!isTransientPatchError(e) || Date.now() - lastAnswer >= patchTiming.deadlineMs) return null;
      }
    }
  };

  // `forced`: install a phased package now (the per-package path that bypasses Ubuntu's rollout); never set for "update all".
  const apply = async (pkg: string | null, forced = false) => {
    // Finishing an interrupted dpkg that includes the container engine restarts Docker: say so first, never silently.
    const interrupted = info?.dpkgInterrupted;
    if (interrupted?.containerEngine) {
      const ok = await confirm({
        title: t("patching.interruptedConfirmTitle"),
        body: t("patching.interruptedConfirm", { packages: interruptedNames(info!).join(", ") }),
        confirmLabel: t("patching.interruptedConfirmButton"),
        danger: true,
      });
      if (!ok) return;
    }
    const before = forced && pkg ? [{ name: pkg }] : (info?.packages ?? []);
    setOutput("");
    setApplyTarget(pkg);
    setPhase("applying");
    setApplying(true);
    let exitCode = 0;
    let dropped = false;
    try {
      const r = pkg && forced ? await api.upgradePhased(id, pkg) : pkg ? await api.upgradeOne(id, pkg) : await api.upgradeAll(id);
      if (!alive.current) return;
      setOutput(settledApplyLog(r.output, streamedRef.current));
      exitCode = r.exitCode;
    } catch (e) {
      if (!alive.current) return;
      setOutput(settledApplyLog(null, streamedRef.current)); // keep the live apt output the owner was watching
      setApplying(false);
      if (!isAgentDropError(e)) {
        // The hub refused or the host couldn't be patched: nothing ran, the list is still true.
        setPhase("idle");
        toast(e instanceof Error ? e.message : t("patching.applyFailed"), "error");
        return;
      }
      dropped = true; // the update most likely restarted Docker, taking the agent with it
    }
    setApplying(false);
    setStale(true);
    setPhase(dropped ? "waiting" : "rechecking");
    const after = await recheck(dropped);
    if (!alive.current) return;
    setPhase("idle");
    if (!after) {
      toast(t("patching.recheckFailedToast"), "error");
      return; // stay stale: never show the old list as if it were current
    }
    setInfo(after);
    setStale(false);
    const sum = summarizeApply(before, after);
    if (!sum) {
      toast(dropped || exitCode !== 0 ? t("patching.recheckFailedToast") : t("patching.applied"), exitCode === 0 ? "info" : "error");
    } else if (exitCode !== 0) {
      toast(t("patching.failedCounts", sum), "error");
    } else if (dropped) {
      toast(t(sum.remaining === 0 ? "patching.restartedDone" : "patching.restartedPartial", sum), sum.remaining === 0 ? "success" : "info");
    } else if (phasedToastKey(sum)) {
      // Ubuntu's phased rollout deferred these: not "held back", and they install by themselves later.
      toast(t(phasedToastKey(sum)!, sum), "info");
    } else if (forced && pkg && sum.remaining === 0) {
      toast(t("patching.appliedOne", { pkg }), "success");
    } else if (sum.remaining === 0) {
      toast(sum.updated > 0 ? t("patching.appliedCounts", sum) : t("patching.appliedNothingLeft"), "success");
    } else if (pkg && !after.packages.some((p) => p.name === pkg)) {
      toast(t("patching.appliedOneCounts", { pkg, remaining: sum.remaining }), "success");
    } else {
      toast(t(sum.updated > 0 ? "patching.appliedPartial" : "patching.appliedNone", sum), sum.updated > 0 ? "info" : "error");
    }
    if (shouldToastReboot(exitCode, sum, after)) toast(t("patching.rebootRequiredToast"), "info");
  };
  const runAll = () => { void apply(null); };
  const runOne = (pkg: string) => { void apply(pkg); };
  const runPhased = (pkg: string) => { void apply(pkg, true); };
  const list = stale ? null : info;

  return (
    <SectionCard
      title={t("patching.title")}
      desc={t("patching.desc")}
      style={{ marginTop: 20 }}
      right={
        <>
          {list?.supported && list.manager && (
            <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "1px 6px" }}>{list.manager}</span>
          )}
          <Btn variant="ghost" onClick={() => check.mutate()} disabled={check.isPending || busy}>
            {check.isPending ? "…" : t("patching.check")}
          </Btn>
        </>
      }
    >

      {check.isError && <div style={{ color: "var(--c-r)", fontSize: 12 }}>{(check.error as Error).message}</div>}

      {phase === "waiting" && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-am)", marginBottom: 10 }}><Spinner /> {t("patching.waitingAgent")}</div>
      )}
      {phase === "running" && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-am)", marginBottom: 10 }}><Spinner /> {t("patching.stillRunning")}</div>
      )}
      {phase === "rechecking" && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx3)", marginBottom: 10 }}><Spinner /> {t("patching.rechecking")}</div>
      )}
      {stale && phase === "idle" && (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-r)", marginBottom: 10 }}><TriangleAlert size={13} aria-hidden style={{ flexShrink: 0 }} /> {t("patching.recheckFailed")}</div>
      )}

      {list && !list.supported && (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("patching.unsupported")}</div>
      )}

      {list && list.supported && (
        <>
          {list.rebootRequired && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 12, color: "var(--c-am)", marginBottom: 10 }}>
              <TriangleAlert size={13} aria-hidden style={{ flexShrink: 0 }} /> {t("patching.rebootRequired")}
              <Btn variant="ghost" onClick={onOpenReboot}>{t("reboot.fromPatching")}</Btn>
            </div>
          )}
          {list.applyRunning && (
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-am)", marginBottom: 10 }}><Spinner /> {t("patching.runningBanner")}</div>
          )}
          {list.dpkgInterrupted && (
            <div role="alert" data-testid="dpkg-interrupted" style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: "var(--c-am)", border: "1px solid var(--c-am)", borderRadius: "var(--r1)", padding: "8px 10px", marginBottom: 10 }}>
              <TriangleAlert size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                {t("patching.interrupted", { packages: list.dpkgInterrupted.packages.map((p) => `${p.name} (${p.state})`).join(", ") })}{" "}
                {list.dpkgInterrupted.containerEngine ? t("patching.interruptedEngine") : t("patching.interruptedRemedy")}
              </span>
            </div>
          )}
          {list.checkFailed ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-r)" }}><TriangleAlert size={13} aria-hidden style={{ flexShrink: 0 }} /> {t("patching.checkFailed")}</div>
          ) : list.count === 0 ? (
            list.dpkgInterrupted ? (
              // Nothing to upgrade, but dpkg is unfinished: "up to date" would be a lie. The update path finishes it.
              <Btn onClick={runAll} loading={phase === "applying" && applyTarget === null} disabled={busy || list.applyRunning}>
                {phase === "applying" && applyTarget === null ? t("patching.running") : t("patching.finishInterrupted")}
              </Btn>
            ) : (
              <div style={{ fontSize: 13, color: "var(--c-g)" }}>{t("patching.upToDate")}</div>
            )
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t("patching.count", { n: list.count })}</span>
                <div style={{ flex: 1 }} />
                <Btn onClick={runAll} loading={phase === "applying" && applyTarget === null} disabled={busy || list.applyRunning}>
                  {phase === "applying" && applyTarget === null ? t("patching.running") : t("patching.updateAll")}
                </Btn>
              </div>
              <RuntimeUpdateWarning packages={containerRuntimeUpdates(list.packages)} />
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                {list.packages.map((p) => (
                  <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, width: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                    <span className="mono" style={{ color: "var(--c-tx3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.current ? `${p.current} → ${p.candidate}` : `↑ ${p.candidate}`}</span>
                    <button
                      onClick={() => runOne(p.name)}
                      disabled={busy || list.applyRunning}
                      aria-busy={(phase === "applying" && applyTarget === p.name) || undefined}
                      style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-lapis)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}
                    >
                      {phase === "applying" && applyTarget === p.name ? t("patching.running") : t("patching.update")}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          {!list.checkFailed && list.phased && list.phased.length > 0 && (
            <div data-testid="phased-updates" style={{ marginBottom: 12, padding: "8px 10px", border: "1px dashed var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)" }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{t("patching.phasedTitle", { n: list.phased.length })}</div>
              <div style={{ fontSize: 12, marginBottom: 8 }}>{t("patching.phasedDesc")}</div>
              <RuntimeUpdateWarning packages={containerRuntimeUpdates(list.phased)} />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {list.phased.map((p) => (
                  <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, width: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                    <span className="mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.current ? `${p.current} → ${p.candidate}` : `↑ ${p.candidate}`}</span>
                    <button
                      onClick={() => runPhased(p.name)}
                      disabled={busy || list.applyRunning}
                      aria-busy={(phase === "applying" && applyTarget === p.name) || undefined}
                      style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-lapis)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}
                    >
                      {phase === "applying" && applyTarget === p.name ? t("patching.running") : t("patching.installNow")}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {logText && (
        <pre ref={logRef} className="mono" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", background: "var(--c-el)", padding: 10, borderRadius: "var(--r1)" }}>{logText}</pre>
      )}
    </SectionCard>
  );
}

function ServerDetailsCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  const [desc, setDesc] = useState(server.description ?? "");
  const [tz, setTz] = useState(server.timezone ?? "");
  useEffect(() => {
    setDesc(server.description ?? "");
    setTz(server.timezone ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);
  const save = useMutation({
    mutationFn: () => api.setServerDetails(id, { description: desc.trim() || null, timezone: tz.trim() || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["server", id] }),
    meta: { successMessage: t("servers.saved") },
  });
  return (
    <SectionCard title={t("servers.details")}>
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder={t("servers.descriptionPlaceholder")}
        aria-label={t("servers.description")}
        spellCheck={false}
        style={{ width: "100%", minHeight: 56, maxHeight: 140, resize: "vertical", fontSize: 13, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Europe/Istanbul" aria-label={t("servers.timezone")} spellCheck={false} style={{ ...cleanupField, minWidth: 200 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("servers.save")}</Btn>
      </div>
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("servers.timezoneHint")}</p>
    </SectionCard>
  );
}

function CleanupCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalH] = useState("24");
  const [cron, setCron] = useState("");
  const [threshold, setThreshold] = useState("");
  const [volumes, setVolumes] = useState(false);
  useEffect(() => {
    setEnabled(server.cleanupEnabled);
    setIntervalH(String(server.cleanupIntervalHours ?? 24));
    setCron(server.cleanupCron ?? "");
    setThreshold(server.cleanupThresholdPct != null ? String(server.cleanupThresholdPct) : "");
    setVolumes(server.cleanupVolumes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const confirm = useConfirm();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["server", id] });
    qc.invalidateQueries({ queryKey: ["server-disk-usage", id] });
    qc.invalidateQueries({ queryKey: ["metrics", id] }); // the disk gauge reads metrics — refresh after a prune
  };
  const clean = useMutation({ mutationFn: () => api.cleanupServer(id), onSuccess: invalidate });
  // Confirm only the destructive path: a plain prune reclaims dangling layers + build cache (safe), but with
  // "Also unused volumes" on it can delete volumes, so gate that behind a danger confirm (error prevention).
  const runClean = async () => {
    if (server.cleanupVolumes && !(await confirm({ title: t("servers.cleanNow"), body: t("servers.cleanConfirmVolumes"), danger: true, confirmLabel: t("servers.cleanNow") }))) return;
    clean.mutate();
  };
  // Read-only disk-usage breakdown so the operator can see WHAT is filling the disk; refreshed after a clean.
  const diskUsage = useQuery({ queryKey: ["server-disk-usage", id], queryFn: () => api.diskUsage(id), staleTime: 30_000, retry: false });
  const save = useMutation({
    // A cron expression (when given) overrides the plain interval server-side; blank clears it. thresholdPct
    // (when set) is an extra trigger: a cleanup also runs when disk usage reaches it; blank clears it.
    mutationFn: () => api.setCleanupConfig(id, { enabled, intervalHours: Number(interval) || 24, cron: cron.trim() || null, thresholdPct: threshold.trim() ? Math.min(100, Math.max(1, Number(threshold) || 0)) : null, volumes }),
    onSuccess: invalidate,
  });

  // Saved state (not the form draft): what the hub will actually do for this server.
  const schedulePart = server.cleanupCron
    ? t("servers.cleanupRunsCron", { cron: server.cleanupCron })
    : server.cleanupIntervalHours
      ? t("servers.cleanupRunsEvery", { hours: server.cleanupIntervalHours })
      : t("servers.cleanupRunsDaily");
  const diskPart = server.cleanupThresholdPct != null ? t("servers.cleanupRunsAtDisk", { pct: server.cleanupThresholdPct }) : t("servers.cleanupRunsNoDisk");

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", flex: 1 }}>{t("servers.cleanup")}</div>
        <Btn onClick={runClean} disabled={clean.isPending}>
          {clean.isPending ? t("servers.cleaning") : t("servers.cleanNow")}
        </Btn>
      </div>
      {(clean.data || clean.isError) && (
        <div role="status" aria-live="polite" style={{ fontSize: 12, margin: "0 0 8px", color: !clean.isError && clean.data?.ok ? "var(--c-g, var(--c-tx2))" : "var(--c-r)" }}>
          {clean.isError
            ? t("servers.cleanFailed")
            : clean.data?.ok
              ? clean.data.reclaimed && clean.data.reclaimed !== "0B"
                ? t("servers.cleanOk", { reclaimed: clean.data.reclaimed })
                : t("servers.cleanOkNothing")
              : `${t("servers.cleanFailed")}${clean.data?.output ? ` — ${clean.data.output.slice(-200)}` : ""}`}
        </div>
      )}
      <div role="status" data-testid="cleanup-state" style={{ margin: "0 0 12px", fontSize: 12, color: "var(--c-tx2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, color: server.cleanupEnabled ? "var(--c-g, var(--c-tx))" : "var(--c-tx)" }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: server.cleanupEnabled ? "var(--c-g, currentColor)" : "var(--c-tx3)" }} />
          {server.cleanupEnabled ? t("servers.cleanupStateOn") : t("servers.cleanupStateOff")}
        </div>
        <div style={{ marginTop: 2 }}>
          {server.cleanupEnabled
            ? `${schedulePart} ${diskPart}.`
            : t("servers.cleanupStateOffHint")}
          {` · ${t("servers.lastCleanup")}: ${server.lastCleanupAt ? new Date(server.lastCleanupAt).toLocaleString() : t("servers.cleanupNeverRan")}`}
        </div>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" }}>{t("servers.cleanupDesc")}</p>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" }}>{t("servers.cleanupKeeps")}</p>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.cleanupDefaults")}</p>
      {diskUsage.data && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, margin: "0 0 12px", fontSize: 12, color: "var(--c-tx2)" }}>
          {(["diskImages", "diskContainers", "diskVolumes", "diskBuildCache"] as const).map((label, i) => {
            const row = [diskUsage.data!.images, diskUsage.data!.containers, diskUsage.data!.volumes, diskUsage.data!.buildCache][i];
            return (
              <div key={label}>
                <span style={{ color: "var(--c-tx3)" }}>{t(`servers.${label}`)}:</span> {row.size}
                {row.reclaimable && row.reclaimable !== "0B" ? ` (${row.reclaimable} ${t("servers.diskReclaimable")})` : ""}
              </div>
            );
          })}
        </div>
      )}
      {diskUsage.isError && <div style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.diskUnavailable")}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("servers.cleanupSchedule")}
        </label>
        <label style={{ fontSize: 12, color: cron.trim() ? "var(--c-tx4, var(--c-tx3))" : "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6, opacity: cron.trim() ? 0.5 : 1 }}>
          {t("servers.cleanupEvery")}
          <input style={cleanupField} type="number" value={interval} onChange={(e) => setIntervalH(e.target.value)} disabled={!!cron.trim()} />
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("servers.cleanupCron")}
          <input style={{ ...cleanupField, width: 130 }} placeholder="0 3 * * *" value={cron} onChange={(e) => setCron(e.target.value)} aria-label={t("servers.cleanupCron")} />
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("servers.cleanupThreshold")}
          <input style={cleanupField} type="number" min={1} max={100} placeholder="80" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label={t("servers.cleanupThreshold")} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={volumes} onChange={(e) => setVolumes(e.target.checked)} />
          {t("servers.cleanupVolumes")}
        </label>
        <Btn variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>{t("servers.save")}</Btn>
      </div>
      {cron.trim() && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("servers.cleanupCronHint")}</p>}
      {threshold.trim() && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("servers.cleanupThresholdHint")}</p>}
      {save.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{(save.error as Error).message}</div>}
    </Card>
  );
}

function DeleteServerCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [destroyVm, setDestroyVm] = useState(true);
  const [confirmName, setConfirmName] = useState("");
  // Only a VM Tugra provisioned can be destroyed with the server: a hand-linked one (out-of-band access) is never ours to delete.
  const canDestroyVm = !!server.provider && !server.providerManualLink;
  const del = useMutation({
    mutationFn: () => api.deleteServer(id, { destroyVm: canDestroyVm && destroyVm }),
    onSuccess: () => router.replace("/servers"),
  });
  const canDelete = !del.isPending && confirmName === server.name;
  return (
    <SectionCard title={t("servers.deleteServer")} desc={t("servers.deleteServerDesc")} style={{ marginTop: 20, borderColor: "var(--c-r)" }}>
      <Btn variant="dangerGhost" onClick={() => { setDestroyVm(true); setConfirmName(""); setOpen(true); }}>{t("servers.deleteServer")}</Btn>
      {open && (
        <Modal onClose={() => setOpen(false)} labelledBy="del-srv-title">
          <h3 id="del-srv-title" style={{ margin: "0 0 8px", fontSize: 15 }}>{t("servers.deleteServer")}</h3>
          <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 12px" }}>{t("servers.deleteConfirm", { name: server.name })}</p>
          {canDestroyVm && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginBottom: 14 }}>
              <input type="checkbox" checked={destroyVm} onChange={(e) => setDestroyVm(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                {t("servers.destroyVmLabel", { provider: server.provider ?? "" })}
                <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", marginTop: 2 }}>{t("servers.destroyVmHint")}</span>
              </span>
            </label>
          )}
          <label style={{ display: "block", marginBottom: 14 }}>
            <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6, lineHeight: 1.5 }}>{t("common.typeToConfirm", { text: server.name })}</span>
            <input
              autoFocus
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canDelete) del.mutate(); }}
              aria-label={t("common.typeToConfirm", { text: server.name })}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              style={fieldStyle}
            />
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setOpen(false)} disabled={del.isPending}>{t("common.cancel")}</Btn>
            <Btn variant="danger" onClick={() => del.mutate()} disabled={!canDelete}>{del.isPending ? "…" : t("servers.deleteServer")}</Btn>
          </div>
          {del.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(del.error as Error).message}</div>}
        </Modal>
      )}
    </SectionCard>
  );
}

function NetworkCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  const [wildcard, setWildcard] = useState("");
  const [suffix, setSuffix] = useState("");
  const [publicIp, setPublicIp] = useState("");
  const [certMode, setCertMode] = useState("http");
  const [dnsProvider, setDnsProvider] = useState("");
  const [dnsCreds, setDnsCreds] = useState(""); // write-only: never seeded from the server
  const [dnsCredId, setDnsCredId] = useState(""); // team DNS credential whose token is copied onto the server
  const toast = useToast();
  const saveFeedback = useSaveFeedback("servers.saved");
  useEffect(() => {
    setWildcard(server.wildcardDomain ?? "");
    setSuffix(server.magicSuffix ?? "");
    setPublicIp(server.ipSource === "manual" ? (server.publicIp ?? "") : "");
    setCertMode(server.certMode || "http");
    setDnsProvider(server.dnsProvider ?? "");
    setDnsCreds("");
    setDnsCredId(server.dnsCredentialId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const save = useMutation({
    mutationFn: () => {
      const cfg: Parameters<typeof api.setServerNetwork>[1] = {
        wildcardDomain: wildcard.trim() || null,
        magicSuffix: suffix.trim() || null,
        certMode: certMode as "http" | "le-dns" | "custom",
        dnsProvider: dnsProvider.trim() || null,
      };
      const ip = publicIp.trim();
      // Only touch the IP pin on a deliberate change: a typed IP pins it (manual),
      // and emptying the field clears an EXISTING manual pin. For an auto-detected
      // IP the field is left empty as a placeholder — don't send it, or Save would
      // wipe the observed address.
      if (ip) cfg.publicIp = ip;
      else if (server.ipSource === "manual") cfg.publicIp = null;
      // Creds are write-only: only send when the operator typed some (an empty box
      // leaves the stored creds untouched). One KEY=VALUE per line.
      const creds = parseCreds(dnsCreds);
      if (creds) cfg.dnsCreds = creds;
      // Only send the credential link on a deliberate change (the token is COPIED, so re-sending would re-copy it).
      if (dnsCredId !== (server.dnsCredentialId ?? "")) cfg.dnsFromCredentialId = dnsCredId || null;
      return api.setServerNetwork(id, cfg);
    },
    onSuccess: () => {
      setDnsCreds("");
      qc.invalidateQueries({ queryKey: ["server", id] });
    },
    ...saveFeedback,
  });

  // Re-send the SAME credential id: the hub copies the credential's current token onto the server again.
  const reapply = useMutation({
    mutationFn: () => api.setServerNetwork(id, { dnsFromCredentialId: server.dnsCredentialId ?? null }),
    onSuccess: () => {
      toast(t("servers.acmeDns.reapplied"), "success");
      qc.invalidateQueries({ queryKey: ["server", id] });
    },
  });

  return (
    <SectionCard id="wildcard" title={t("servers.networkTitle")} desc={t("servers.networkDesc")} style={{ marginTop: 20, scrollMarginTop: 80 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
          {t("servers.wildcardDomain")}
          <input style={netField} value={wildcard} placeholder="apps.example.com" onChange={(e) => setWildcard(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
          {t("servers.magicSuffix")}
          <input style={netField} value={suffix} placeholder="sslip.io" onChange={(e) => setSuffix(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
          <span>
            {t("servers.manualIp")}{" "}
            <span style={{ color: server.ipSource === "manual" ? "var(--c-am)" : "var(--c-tx3)" }}>
              ({t(server.ipSource === "manual" ? "servers.ipSourceManual" : "servers.ipSourceObserved")})
            </span>
          </span>
          <input style={netField} value={publicIp} placeholder={server.publicIp ?? "203.0.113.7"} onChange={(e) => setPublicIp(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
          {t("servers.certMode")}
          <select style={netField} value={certMode} onChange={(e) => setCertMode(e.target.value)}>
            <option value="http">{t("servers.certModeHttp")}</option>
            <option value="le-dns">{t("servers.certModeLeDns")}</option>
          </select>
        </label>
        {certMode === "le-dns" && (
          <>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
              {t("servers.dnsProvider")}
              <input style={netField} value={dnsProvider} placeholder="cloudflare" onChange={(e) => setDnsProvider(e.target.value)} />
              <span style={{ fontSize: 11 }}>{t("servers.dnsProviderHint")}</span>
            </label>
            <AcmeDnsCredentialPicker
              teamId={server.teamId}
              value={dnsCredId}
              onChange={setDnsCredId}
              linkedId={server.dnsCredentialId ?? null}
              onReapply={() => reapply.mutate()}
              reapplying={reapply.isPending}
            />
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
              <span>
                {t("servers.dnsCreds")}{" "}
                {server.hasDnsCreds && <span style={{ color: "var(--c-g)" }}>({t("servers.dnsCredsSet")})</span>}
              </span>
              <textarea
                style={{ ...netField, minHeight: 64, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
                value={dnsCreds}
                placeholder={"CF_DNS_API_TOKEN=your-token"}
                onChange={(e) => setDnsCreds(e.target.value)}
              />
              <span style={{ fontSize: 11 }}>{t("servers.dnsCredsHint")}</span>
            </label>
          </>
        )}
        <div>
          <Btn variant="ghost" onClick={() => save.mutate()} loading={save.isPending} disabled={save.isPending}>{t("servers.save")}</Btn>
        </div>
      </div>
    </SectionCard>
  );
}

/** Parse a KEY=VALUE-per-line creds box into a record, or null when empty. */
function parseCreds(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

const netField: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

const PROXY_COLOR: Record<ProxyStatus, string> = {
  running: "var(--c-g)",
  stopped: "var(--c-am)",
  absent: "var(--c-tx3)",
};

function ProxyCard({ id, canWrite }: { id: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [logs, setLogs] = useState("");
  const status = useQuery({ queryKey: ["proxy", id], queryFn: () => api.getProxyStatus(id) });
  const st = status.data?.status;
  const refresh = () => qc.invalidateQueries({ queryKey: ["proxy", id] });
  const toast = useToast();
  // The proxy calls return only once the work is done and a restart leaves the pill at "running", so without a
  // toast the click looks like it did nothing.
  const onDone = (key: "servers.proxyStarted" | "servers.proxyStopped" | "servers.proxyRestarted") => (r: { status: ProxyStatus }) => {
    qc.setQueryData(["proxy", id], r);
    toast(t(key), "success");
  };
  const confirm = useConfirm();

  const start = useMutation({ mutationFn: () => api.startProxy(id), onSuccess: onDone("servers.proxyStarted") });
  const stop = useMutation({ mutationFn: () => api.stopProxy(id), onSuccess: onDone("servers.proxyStopped") });
  const restart = useMutation({ mutationFn: () => api.restartProxy(id), onSuccess: onDone("servers.proxyRestarted") });
  const viewLogs = useMutation({ mutationFn: () => api.getProxyLogs(id), onSuccess: (r) => setLogs(r.output || "—") });
  const busy = start.isPending || stop.isPending || restart.isPending;

  return (
    <SectionCard
      title={t("servers.proxy")}
      desc={t("servers.proxyDesc")}
      style={{ marginTop: 20 }}
      right={
        <>
          {st && <StatusPill label={t(`servers.st_${st}`)} color={PROXY_COLOR[st]} />}
          {canWrite && (
            <>
              <Btn variant="ghost" icon={Play} iconTone="success" loading={start.isPending} onClick={() => start.mutate()} disabled={busy}>{t("servers.proxyStart")}</Btn>
              <Btn variant="ghost" icon={RotateCw} iconTone="warn" loading={restart.isPending} onClick={() => restart.mutate()} disabled={busy}>{t("servers.proxyRestart")}</Btn>
              <Btn variant="dangerGhost" icon={Square} loading={stop.isPending} onClick={async () => { if (await confirm({ body: t("servers.proxyStopConfirm"), danger: true })) stop.mutate(); }} disabled={busy}>{t("servers.proxyStop")}</Btn>
            </>
          )}
        </>
      }
    >
      <Btn variant="ghost" icon={ScrollText} onClick={() => viewLogs.mutate()} disabled={viewLogs.isPending}>
        {viewLogs.isPending ? "…" : t("servers.proxyViewLogs")}
      </Btn>
      <button onClick={refresh} disabled={status.isFetching} aria-label={t("servers.proxyRefresh")} aria-busy={status.isFetching || undefined} style={{ marginLeft: 8, background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}><RefreshCw size={13} aria-hidden style={status.isFetching ? { animation: "spin 0.7s linear infinite" } : undefined} /></button>
      {logs && (
        <pre className="mono" style={{ margin: "10px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", background: "var(--c-el)", padding: 10, borderRadius: "var(--r1)" }}>{logs}</pre>
      )}
    </SectionCard>
  );
}

// Operator-authored Traefik dynamic-config files (Coolify "Proxy > Dynamic Configurations" parity).
const DYN_TA: React.CSSProperties = { width: "100%", boxSizing: "border-box", minHeight: 96, fontFamily: "monospace", fontSize: 12, padding: 8, borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", background: "var(--c-el)", color: "var(--c-tx)", resize: "vertical" };

function ProxyDynamicCard({ id, canWrite }: { id: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["proxy-dynamic", id], queryFn: () => api.listProxyDynamicConfigs(id) });
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["proxy-dynamic", id] });
  const create = useMutation({
    mutationFn: () => api.putProxyDynamicConfig(id, newName.trim(), newContent),
    onSuccess: () => { setNewName(""); setNewContent(""); refresh(); },
  });
  const configs = list.data?.configs ?? [];
  return (
    <SectionCard title={t("servers.proxyDynamic")} desc={t("servers.proxyDynamicDesc")} style={{ marginTop: 20 }}>
      {configs.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("servers.proxyDynamicEmpty")}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {configs.map((c) => (
          <DynamicConfigRow key={c.name} id={id} name={c.name} initial={c.content} canWrite={canWrite} onChanged={refresh} />
        ))}
      </div>
      {canWrite && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--c-bd)", paddingTop: 14 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("servers.proxyDynamicAdd")}</div>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("servers.proxyDynamicName")} aria-label={t("servers.proxyDynamicName")} className="mono" style={{ ...DYN_TA, minHeight: 0, marginBottom: 8 }} />
          <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} placeholder={"http:\n  middlewares:\n    my-rate:\n      rateLimit:\n        average: 100"} aria-label={t("servers.proxyDynamicContent")} style={DYN_TA} />
          {create.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 6 }}>{(create.error as Error).message}</div>}
          <div style={{ marginTop: 8 }}><Btn onClick={() => create.mutate()} disabled={create.isPending || !newName.trim() || !newContent.trim()}>{t("servers.proxyDynamicCreate")}</Btn></div>
        </div>
      )}
    </SectionCard>
  );
}

function DynamicConfigRow({ id, name, initial, canWrite, onChanged }: { id: string; name: string; initial: string; canWrite: boolean; onChanged: () => void }) {
  const t = useT();
  const confirm = useConfirm();
  const [content, setContent] = useState(initial);
  const saveFeedback = useSaveFeedback("servers.proxyDynamicSaved");
  const save = useMutation({ mutationFn: () => api.putProxyDynamicConfig(id, name, content), onSuccess: onChanged, ...saveFeedback });
  const del = useMutation({ mutationFn: () => api.deleteProxyDynamicConfig(id, name), onSuccess: onChanged });
  return (
    <div>
      <div className="mono" style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>user-{name}.yml</div>
      <textarea value={content} onChange={(e) => setContent(e.target.value)} disabled={!canWrite} aria-label={`user-${name}.yml`} style={DYN_TA} />
      {save.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 6 }}>{(save.error as Error).message}</div>}
      {canWrite && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <Btn onClick={() => save.mutate()} loading={save.isPending} disabled={save.isPending || content === initial}>{t("servers.proxyDynamicSave")}</Btn>
          <Btn variant="dangerGhost" onClick={async () => { if (await confirm({ body: t("servers.proxyDynamicDeleteConfirm", { name }), danger: true })) del.mutate(); }} disabled={del.isPending}>{t("servers.proxyDynamicDelete")}</Btn>
        </div>
      )}
    </div>
  );
}

const TUNNEL_COLOR: Record<string, string> = {
  connected: "var(--c-g)",
  connecting: "var(--c-am)",
  pending: "var(--c-am)",
  error: "var(--c-r)",
  disabled: "var(--c-tx3)",
};

const tunLabel: React.CSSProperties = { fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 };

function TunnelInfo({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
      <span style={{ color: "var(--c-tx3)" }}>{label}</span>
      <span style={{ color: "var(--c-tx)", fontWeight: 500, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

/** Cloudflare Tunnel: expose a NAT/no-public-IP server's apps to the internet (zero-IP). */
function TunnelCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canWrite = server.canWrite;
  const status = useQuery({ queryKey: ["tunnel", id], queryFn: () => api.getTunnelStatus(id) });
  const tun = status.data;
  const [apiToken, setApiToken] = useState("");
  const [cfAccountId, setCfAccountId] = useState("");
  const [zoneName, setZoneName] = useState("");
  const [wildcardDomain, setWildcardDomain] = useState("");

  const toast = useToast();
  const setup = useMutation({
    mutationFn: () =>
      api.setupTunnel(id, {
        apiToken: apiToken.trim(),
        cfAccountId: cfAccountId.trim(),
        zoneName: zoneName.trim(),
        wildcardDomain: wildcardDomain.trim() || undefined,
      }),
    onSuccess: (r) => {
      setApiToken("");
      // The hub returns before cloudflared has dialled in, so the status is usually still "connecting".
      toast(t(r.status === "connected" ? "servers.tunnelConnected" : "servers.tunnelConnecting"), "success");
      qc.invalidateQueries({ queryKey: ["tunnel", id] });
      qc.invalidateQueries({ queryKey: ["server", id] });
    },
  });
  const teardown = useMutation({
    mutationFn: () => api.teardownTunnel(id),
    onSuccess: () => {
      toast(t("servers.tunnelDisconnected"), "success");
      qc.invalidateQueries({ queryKey: ["tunnel", id] });
    },
  });

  const st = tun?.status ?? undefined;

  return (
    <SectionCard
      title={t("servers.tunnelTitle")}
      desc={t("servers.tunnelDesc")}
      style={{ marginTop: 20 }}
      right={tun?.configured && st && <StatusPill label={t(`servers.tunnelSt_${st}`)} color={TUNNEL_COLOR[st] ?? "var(--c-tx3)"} />}
    >

      {server.certMode !== "http" && (
        <p style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 12px" }}>{t("servers.tunnelCertWarn")}</p>
      )}

      {tun?.configured ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <TunnelInfo label={t("servers.tunnelZoneName")} value={tun.zoneName ?? "—"} />
          <TunnelInfo label={t("servers.wildcardDomain")} value={tun.wildcardDomain ?? "—"} />
          {tun.lastError && (
            <p style={{ fontSize: 12, color: "var(--c-r)", margin: 0, wordBreak: "break-word" }}>{tun.lastError}</p>
          )}
          {canWrite && (
            <div>
              <Btn
                variant="ghost"
                onClick={async () => {
                  if (await confirm({ body: t("servers.tunnelDisconnectConfirm"), danger: true })) teardown.mutate();
                }}
                loading={teardown.isPending}
                disabled={teardown.isPending}
              >
                {teardown.isPending ? t("servers.tunnelDisconnecting") : t("servers.tunnelDisconnect")}
              </Btn>
            </div>
          )}
        </div>
      ) : canWrite ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={tunLabel}>
            {t("servers.tunnelApiToken")}
            <input style={netField} type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} />
            <span style={{ fontSize: 11 }}>{t("servers.tunnelApiTokenHint")}</span>
          </label>
          <label style={tunLabel}>
            {t("servers.tunnelAccountId")}
            <input style={netField} value={cfAccountId} onChange={(e) => setCfAccountId(e.target.value)} />
          </label>
          <label style={tunLabel}>
            {t("servers.tunnelZoneName")}
            <input style={netField} value={zoneName} placeholder="example.com" onChange={(e) => setZoneName(e.target.value)} />
          </label>
          <label style={tunLabel}>
            {t("servers.tunnelWildcardDomain")}
            <input style={netField} value={wildcardDomain} placeholder="apps.example.com" onChange={(e) => setWildcardDomain(e.target.value)} />
            <span style={{ fontSize: 11 }}>{t("servers.tunnelWildcardHint")}</span>
          </label>
          {setup.isError && <p style={{ fontSize: 12, color: "var(--c-r)", margin: 0 }}>{t("servers.tunnelSetupFailed")}</p>}
          <div>
            <Btn
              variant="ghost"
              onClick={() => setup.mutate()}
              loading={setup.isPending}
              disabled={setup.isPending || !apiToken.trim() || !cfAccountId.trim() || !zoneName.trim()}
            >
              {setup.isPending ? t("servers.tunnelConnectingBtn") : t("servers.tunnelConnect")}
            </Btn>
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("servers.tunnelNotConfigured")}</p>
      )}
    </SectionCard>
  );
}

const cleanupField: React.CSSProperties = {
  width: 64,
  padding: "5px 8px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "inherit",
};

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
