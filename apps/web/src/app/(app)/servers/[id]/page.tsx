"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { TriangleAlert, RefreshCw, LayoutDashboard, Activity, Boxes, PackageCheck, Waypoints, Wrench, Terminal, Plus, Play, RotateCw, Square, ScrollText } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { ErrorState } from "../../../../components/error-state";
import { installPhase } from "../../../../lib/server-install";
import { useTabState } from "../../../../hooks/useTabState";
import { CopyBtn } from "../../../../components/copy-row";
import { IconBtn } from "../../../../components/icon-btn";
import { useConfirm } from "../../../../components/confirm";
import { pct, fmtBytesStr, formatUptime } from "../../../../lib/fleet";
import { humanizeRateSeries } from "../../../../lib/metrics";
import type { MetricsRange, ServerStatus, ServerView } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { MetricChart } from "../../../../components/charts";
import { ServerContainersCard } from "../../../../components/server-containers-card";
import { LiveGauges } from "../../../../components/live-gauges";
import { DiscoverAdoptCard } from "../../../../components/discover-adopt-card";
import { Modal } from "../../../../components/modal";
import { fieldStyle } from "../../../../components/form";
import { TerminalModal } from "../../../../components/terminal-modal";
import { TagsCard } from "../../../../components/tags";
import { Badge, Btn, Card, EmptyState, Spinner, StatusPill } from "../../../../components/ui";
import { Skeleton, SkeletonCard } from "../../../../components/skeleton";
import type { ProxyStatus } from "../../../../lib/types";
import { PageHeader } from "../../../../components/page-header";
import { Tabs } from "../../../../components/tabs-nav";
import { usePatchLogStream } from "../../../../hooks/useDeployLogStream";
import { useMetricsStream } from "../../../../hooks/useMetricsStream";

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
  const [shellOpen, setShellOpen] = useState(false);
  const tabDefs = [
    { key: "overview", label: t("servers.tabOverview"), icon: LayoutDashboard },
    { key: "monitoring", label: t("servers.tabMonitoring"), icon: Activity },
    { key: "containers", label: t("servers.tabContainers"), icon: Boxes },
    ...(server?.canWrite ? [{ key: "updates", label: t("servers.tabUpdates"), icon: PackageCheck }, { key: "drains", label: t("servers.tabDrains"), icon: Waypoints }] : []),
    { key: "maintenance", label: t("servers.tabMaintenance"), icon: Wrench },
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

  if (isError && !server) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !server) return <ServerDetailSkeleton />;

  const cpu = metrics.map((m) => m.cpu);
  const ram = metrics.map((m) => pct(m.memUsed, m.memTotal));
  const netIn = humanizeRateSeries(metrics.map((m) => m.netRx));
  const netOut = humanizeRateSeries(metrics.map((m) => m.netTx));
  // `?? 0`: an older agent's live SSE sample omits diskRead/diskWrite (undefined) — default it so the
  // rate humanizer picks the right unit and the chart never sees a non-finite value.
  const diskRead = humanizeRateSeries(metrics.map((m) => m.diskRead ?? 0));
  const diskWrite = humanizeRateSeries(metrics.map((m) => m.diskWrite ?? 0));

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
            <Btn icon={Terminal} variant="ghost" onClick={() => setShellOpen(true)}>{t("servers.openHostShell")}</Btn>
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
          <LiveGauges id={id} nowMs={Date.now()} />
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
        </>
      )}

      {tab === "monitoring" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["live", "1h", "6h", "24h", "7d"] as const).map((r) => (
              <Btn key={r} variant={r === range ? "primary" : "ghost"} onClick={() => setRange(r)}>
                {t(`servers.range${r === "live" ? "Live" : r}`)}
              </Btn>
            ))}
          </div>
          {metrics.length === 0 ? (
            <Card style={{ padding: 16 }}><EmptyState>{t("servers.noMetrics")}</EmptyState></Card>
          ) : (
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
              <MetricChart data={cpu} label={t("servers.cpu")} unit="%" color="var(--c-a)" />
              <MetricChart data={ram} label={t("servers.ram")} unit="%" color="var(--c-lapis)" />
              <MetricChart data={netIn.data} label={t("servers.netIn")} unit={" " + netIn.unit} color="var(--c-g)" decimals={1} />
              <MetricChart data={netOut.data} label={t("servers.netOut")} unit={" " + netOut.unit} color="var(--c-am)" decimals={1} />
              <MetricChart data={diskRead.data} label={t("servers.diskRead")} unit={" " + diskRead.unit} color="var(--c-lapis)" decimals={1} />
              <MetricChart data={diskWrite.data} label={t("servers.diskWrite")} unit={" " + diskWrite.unit} color="var(--c-am)" decimals={1} />
            </div>
          )}
        </div>
      )}

      {tab === "containers" && <ServerContainersCard id={id} canWrite={server.canWrite} />}

      {tab === "updates" && server.canWrite && <PatchCard id={id} />}

      {tab === "drains" && server.canWrite && <LogDrainCard id={id} />}

      {tab === "maintenance" && (
        <>
          <TagsCard tags={server.tags} canWrite={server.canWrite} onSave={(next) => tags.mutate(next)} />
          <ProxyCard id={id} canWrite={server.canWrite} />
          {server.canWrite && <NetworkCard id={id} server={server} />}
          <TunnelCard id={id} server={server} />
          {server.canWrite && <CapabilitiesCard id={id} server={server} />}
          {server.canWrite && <CleanupCard id={id} server={server} />}
          {server.canWrite && <DiscoverAdoptCard id={id} />}
          {server.canWrite && <DeleteServerCard id={id} server={server} />}
        </>
      )}
      </>
      )}

      {shellOpen && (
        <TerminalModal
          target={{ server: id }}
          title={t("terminal.hostTitle", { name: server.name })}
          onClose={() => setShellOpen(false)}
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

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i}>
            <Skeleton height={12} width={80} style={{ marginBottom: 12 }} />
            <Skeleton height={120} />
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
    <Card style={{ padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{t("servers.installTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.installDesc")}</p>

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
    </Card>
  );
}

function PatchCard({ id }: { id: string }) {
  const t = useT();
  const [output, setOutput] = useState("");
  const [applying, setApplying] = useState(false);
  const log = usePatchLogStream(id, applying);
  const check = useMutation({ mutationFn: () => api.checkUpdates(id) });
  const info = check.data;
  const upgradeAll = useMutation({
    mutationFn: () => api.upgradeAll(id),
    onSuccess: (r) => { setOutput(r.output); check.mutate(); },
    onSettled: () => setApplying(false),
  });
  const upgradeOne = useMutation({
    mutationFn: (pkg: string) => api.upgradeOne(id, pkg),
    onSuccess: (r) => { setOutput(r.output); check.mutate(); },
    onSettled: () => setApplying(false),
  });
  const busy = upgradeAll.isPending || upgradeOne.isPending;
  const runAll = () => { setOutput(""); setApplying(true); upgradeAll.mutate(); };
  const runOne = (pkg: string) => { setOutput(""); setApplying(true); upgradeOne.mutate(pkg); };

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, flex: 1 }}>{t("patching.title")}</div>
        {info?.supported && info.manager && (
          <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "1px 6px" }}>{info.manager}</span>
        )}
        <Btn variant="ghost" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? "…" : t("patching.check")}
        </Btn>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("patching.desc")}</p>

      {check.isError && <div style={{ color: "var(--c-r)", fontSize: 12 }}>{(check.error as Error).message}</div>}

      {info && !info.supported && (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("patching.unsupported")}</div>
      )}

      {info && info.supported && (
        <>
          {info.rebootRequired && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-am)", marginBottom: 10 }}><TriangleAlert size={13} aria-hidden style={{ flexShrink: 0 }} /> {t("patching.rebootRequired")}</div>
          )}
          {info.checkFailed ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-r)" }}><TriangleAlert size={13} aria-hidden style={{ flexShrink: 0 }} /> {t("patching.checkFailed")}</div>
          ) : info.count === 0 ? (
            <div style={{ fontSize: 13, color: "var(--c-g)" }}>{t("patching.upToDate")}</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t("patching.count", { n: info.count })}</span>
                <div style={{ flex: 1 }} />
                <Btn onClick={runAll} disabled={busy}>
                  {upgradeAll.isPending ? t("patching.running") : t("patching.updateAll")}
                </Btn>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                {info.packages.map((p) => (
                  <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, width: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                    <span className="mono" style={{ color: "var(--c-tx3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.current ? `${p.current} → ${p.candidate}` : `↑ ${p.candidate}`}</span>
                    <button
                      onClick={() => runOne(p.name)}
                      disabled={busy}
                      style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-lapis)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}
                    >
                      {t("patching.update")}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {(applying ? log.lines : output) && (
        <pre className="mono" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", background: "var(--c-el)", padding: 10, borderRadius: "var(--r1)" }}>{applying ? log.lines : output}</pre>
      )}
    </Card>
  );
}

function LogDrainCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: drains = [] } = useQuery({ queryKey: ["logDrains", id], queryFn: () => api.listLogDrains(id) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["logDrains", id] });
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const add = useMutation({
    mutationFn: () => api.createLogDrain(id, { name, endpoint, token: token || undefined }),
    onSuccess: () => { setName(""); setEndpoint(""); setToken(""); invalidate(); },
  });
  const toggle = useMutation({
    mutationFn: ({ drainId, enabled }: { drainId: string; enabled: boolean }) => api.updateLogDrain(id, drainId, { enabled }),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: (drainId: string) => api.deleteLogDrain(id, drainId), onSuccess: invalidate });
  const field: React.CSSProperties = { padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit" };

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("logdrains.title")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("logdrains.desc")}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {drains.map((d) => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <input type="checkbox" checked={d.enabled} onChange={(e) => toggle.mutate({ drainId: d.id, enabled: e.target.checked })} />
            <span style={{ fontWeight: 600, width: 130, overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{d.endpoint}</span>
            <IconBtn label={t("common.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(d.id); }}>×</IconBtn>
          </div>
        ))}
        {drains.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("logdrains.empty")}</div>}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...field, width: 130 }} placeholder={t("logdrains.name")} value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ ...field, flex: 1, minWidth: 180 }} placeholder={t("logdrains.endpoint")} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
        <input style={{ ...field, width: 150 }} type="password" placeholder={t("logdrains.token")} value={token} onChange={(e) => setToken(e.target.value)} />
        <Btn onClick={() => add.mutate()} disabled={add.isPending || !name || !endpoint}>{t("logdrains.add")}</Btn>
      </div>
      {add.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(add.error as Error).message}</div>}
    </Card>
  );
}

function CleanupCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalH] = useState("24");
  const [volumes, setVolumes] = useState(false);
  useEffect(() => {
    setEnabled(server.cleanupEnabled);
    setIntervalH(String(server.cleanupIntervalHours ?? 24));
    setVolumes(server.cleanupVolumes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["server", id] });
  const clean = useMutation({ mutationFn: () => api.cleanupServer(id), onSuccess: invalidate });
  const save = useMutation({
    mutationFn: () => api.setCleanupConfig(id, { enabled, intervalHours: Number(interval) || 24, volumes }),
    onSuccess: invalidate,
  });

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", flex: 1 }}>{t("servers.cleanup")}</div>
        <Btn onClick={() => clean.mutate()} disabled={clean.isPending}>
          {clean.isPending ? t("servers.cleaning") : t("servers.cleanNow")}
        </Btn>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>
        {t("servers.cleanupDesc")}
        {server.lastCleanupAt ? ` · ${t("servers.lastCleanup")}: ${new Date(server.lastCleanupAt).toLocaleString()}` : ""}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("servers.cleanupSchedule")}
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("servers.cleanupEvery")}
          <input style={cleanupField} type="number" value={interval} onChange={(e) => setIntervalH(e.target.value)} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={volumes} onChange={(e) => setVolumes(e.target.checked)} />
          {t("servers.cleanupVolumes")}
        </label>
        <Btn variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>{t("servers.save")}</Btn>
      </div>
    </Card>
  );
}

function DeleteServerCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [destroyVm, setDestroyVm] = useState(true);
  const [confirmName, setConfirmName] = useState("");
  const del = useMutation({
    mutationFn: () => api.deleteServer(id, { destroyVm: !!server.provider && destroyVm }),
    onSuccess: () => router.replace("/servers"),
  });
  const canDelete = !del.isPending && confirmName === server.name;
  return (
    <Card style={{ padding: 16, marginTop: 20, borderColor: "var(--c-r)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("servers.deleteServer")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.deleteServerDesc")}</p>
      <Btn variant="dangerGhost" onClick={() => { setDestroyVm(true); setConfirmName(""); setOpen(true); }}>{t("servers.deleteServer")}</Btn>
      {open && (
        <Modal onClose={() => setOpen(false)} labelledBy="del-srv-title">
          <h3 id="del-srv-title" style={{ margin: "0 0 8px", fontSize: 15 }}>{t("servers.deleteServer")}</h3>
          <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 12px" }}>{t("servers.deleteConfirm", { name: server.name })}</p>
          {server.provider && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginBottom: 14 }}>
              <input type="checkbox" checked={destroyVm} onChange={(e) => setDestroyVm(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                {t("servers.destroyVmLabel", { provider: server.provider })}
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
    </Card>
  );
}

const CAPABILITIES = ["deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch", "logs", "swarm"];

function CapabilitiesCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  // The checked set IS the granted set: what's ticked is exactly what the hub may do. An empty
  // grant means "nothing allowed" (fail-safe) — unchecking everything revokes, never grants.
  const [caps, setCaps] = useState<Set<string>>(() => new Set(server.capabilities));
  useEffect(() => {
    setCaps(new Set(server.capabilities));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);
  const toggle = (c: string) =>
    setCaps((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  const save = useMutation({
    mutationFn: () => api.setServerCapabilities(id, [...caps]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["server", id] }),
  });
  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("servers.capabilities")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.capabilitiesDesc")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
        {CAPABILITIES.map((c) => (
          <label key={c} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
            <input type="checkbox" checked={caps.has(c)} onChange={() => toggle(c)} />
            {t(`servers.cap_${c}`)}
          </label>
        ))}
      </div>
      <Btn variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>{t("servers.save")}</Btn>
      {save.isSuccess && <span style={{ fontSize: 12, color: "var(--c-g)", marginLeft: 10 }}>{t("servers.capsSaved")}</span>}
    </Card>
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
  useEffect(() => {
    setWildcard(server.wildcardDomain ?? "");
    setSuffix(server.magicSuffix ?? "");
    setPublicIp(server.ipSource === "manual" ? (server.publicIp ?? "") : "");
    setCertMode(server.certMode || "http");
    setDnsProvider(server.dnsProvider ?? "");
    setDnsCreds("");
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
      return api.setServerNetwork(id, cfg);
    },
    onSuccess: () => {
      setDnsCreds("");
      qc.invalidateQueries({ queryKey: ["server", id] });
    },
  });

  return (
    <Card id="wildcard" style={{ padding: 16, marginTop: 20, scrollMarginTop: 80 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("servers.networkTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.networkDesc")}</p>
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
          <Btn variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>{t("servers.save")}</Btn>
        </div>
      </div>
    </Card>
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
  const onResult = (r: { status: ProxyStatus }) => qc.setQueryData(["proxy", id], r);

  const start = useMutation({ mutationFn: () => api.startProxy(id), onSuccess: onResult });
  const stop = useMutation({ mutationFn: () => api.stopProxy(id), onSuccess: onResult });
  const restart = useMutation({ mutationFn: () => api.restartProxy(id), onSuccess: onResult });
  const viewLogs = useMutation({ mutationFn: () => api.getProxyLogs(id), onSuccess: (r) => setLogs(r.output || "—") });
  const busy = start.isPending || stop.isPending || restart.isPending;

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600 }}>{t("servers.proxy")}</div>
        {st && <StatusPill label={t(`servers.st_${st}`)} color={PROXY_COLOR[st]} />}
        <div style={{ flex: 1 }} />
        {canWrite && (
          <>
            <Btn variant="ghost" icon={Play} onClick={() => start.mutate()} disabled={busy}>{t("servers.proxyStart")}</Btn>
            <Btn variant="ghost" icon={RotateCw} onClick={() => restart.mutate()} disabled={busy}>{t("servers.proxyRestart")}</Btn>
            <Btn variant="dangerGhost" icon={Square} onClick={() => stop.mutate()} disabled={busy}>{t("servers.proxyStop")}</Btn>
          </>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.proxyDesc")}</p>
      <Btn variant="ghost" icon={ScrollText} onClick={() => viewLogs.mutate()} disabled={viewLogs.isPending}>
        {viewLogs.isPending ? "…" : t("servers.proxyViewLogs")}
      </Btn>
      <button onClick={refresh} aria-label={t("servers.proxyViewLogs")} style={{ marginLeft: 8, background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}><RefreshCw size={13} /></button>
      {logs && (
        <pre className="mono" style={{ margin: "10px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", background: "var(--c-el)", padding: 10, borderRadius: "var(--r1)" }}>{logs}</pre>
      )}
    </Card>
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

  const setup = useMutation({
    mutationFn: () =>
      api.setupTunnel(id, {
        apiToken: apiToken.trim(),
        cfAccountId: cfAccountId.trim(),
        zoneName: zoneName.trim(),
        wildcardDomain: wildcardDomain.trim() || undefined,
      }),
    onSuccess: () => {
      setApiToken("");
      qc.invalidateQueries({ queryKey: ["tunnel", id] });
      qc.invalidateQueries({ queryKey: ["server", id] });
    },
  });
  const teardown = useMutation({
    mutationFn: () => api.teardownTunnel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tunnel", id] }),
  });

  const st = tun?.status ?? undefined;

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600 }}>{t("servers.tunnelTitle")}</div>
        {tun?.configured && st && <StatusPill label={t(`servers.tunnelSt_${st}`)} color={TUNNEL_COLOR[st] ?? "var(--c-tx3)"} />}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.tunnelDesc")}</p>

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
                disabled={teardown.isPending}
              >
                {t("servers.tunnelDisconnect")}
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
              disabled={setup.isPending || !apiToken.trim() || !cfAccountId.trim() || !zoneName.trim()}
            >
              {setup.isPending ? "…" : t("servers.tunnelConnect")}
            </Btn>
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("servers.tunnelNotConfigured")}</p>
      )}
    </Card>
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
