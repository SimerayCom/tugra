"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
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
import type { ServerStatus, ServerView } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { MetricChart } from "../../../../components/charts";
import { TerminalModal } from "../../../../components/terminal-modal";
import { TagsCard } from "../../../../components/tags";
import { Badge, Btn, Card, EmptyState, Spinner, StatusPill } from "../../../../components/ui";
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
  const { data: metrics = [] } = useQuery({
    queryKey: ["metrics", id],
    queryFn: () => api.getMetrics(id, 60),
    refetchInterval: 30000, // slow heal/fallback; live updates arrive via SSE below
  });
  const [shellOpen, setShellOpen] = useState(false);
  const tabDefs = [
    { key: "overview", label: t("servers.tabOverview") },
    { key: "monitoring", label: t("servers.tabMonitoring") },
    ...(server?.canWrite ? [{ key: "updates", label: t("servers.tabUpdates") }, { key: "drains", label: t("servers.tabDrains") }] : []),
    { key: "maintenance", label: t("servers.tabMaintenance") },
  ];
  const [tab, setTab] = useTabState("overview", tabDefs.map((d) => d.key));
  // Push live samples into the metrics cache while the monitoring tab is open.
  useMetricsStream(id, tab === "monitoring");

  // Celebrate the PENDING → ONLINE moment with a forward CTA (no dead-end).
  const prevStatus = useRef<ServerStatus | null>(null);
  const [enrolled, setEnrolled] = useState(false);
  useEffect(() => {
    if (prevStatus.current === "PENDING" && server?.status === "ONLINE") setEnrolled(true);
    if (server) prevStatus.current = server.status;
  }, [server?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isError && !server) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !server) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;

  const cpu = metrics.map((m) => m.cpu);
  const ram = metrics.map((m) => pct(m.memUsed, m.memTotal));
  const netIn = humanizeRateSeries(metrics.map((m) => m.netRx));
  const netOut = humanizeRateSeries(metrics.map((m) => m.netTx));

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={[{ label: t("nav.servers"), href: "/servers" }, { label: server.name }]}
        title={server.name}
        status={{ label: server.status, color: serverColor(server.status) }}
        badge={<Badge tone={server.canWrite ? "gold" : "muted"}>{server.role}</Badge>}
        actions={server.canWrite ? (
          <>
            <Link href={`/resources/new?server=${id}`}><Btn>{t("servers.addResource")}</Btn></Link>
            <Btn variant="ghost" onClick={() => setShellOpen(true)}>{t("servers.openHostShell")}</Btn>
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
          <Card style={{ padding: 16, marginBottom: 20, display: "flex", gap: 28, flexWrap: "wrap" }}>
            <Info label={t("servers.status")} value={server.status} />
            <Info label={t("servers.ipAddress")} value={server.publicIp ?? server.publicIpv6 ?? "—"} />
            <Info label={t("servers.team")} value={server.teamId.slice(0, 8)} />
            <Info label={t("servers.sealLabel")} value={server.seal ? t("servers.sealed") : "—"} />
            <Info label={t("servers.lastSeen")} value={server.lastSeenAt ? new Date(server.lastSeenAt).toLocaleTimeString() : "—"} />
          </Card>
          {(server.os || server.arch || server.cpuCores) && (
            <Card style={{ padding: 16, display: "flex", gap: 28, flexWrap: "wrap" }}>
              <Info label={t("servers.os")} value={server.os ? `${server.os} ${server.osVersion ?? ""}`.trim() : "—"} />
              <Info label={t("servers.arch")} value={server.arch ?? "—"} />
              <Info label={t("servers.kernel")} value={server.kernel ?? "—"} />
              <Info label={t("servers.cpuCores")} value={server.cpuCores != null ? String(server.cpuCores) : "—"} />
              <Info label={t("servers.ramTotal")} value={fmtBytesStr(server.memTotalBytes)} />
              <Info label={t("servers.uptime")} value={formatUptime(server.uptimeSeconds)} />
            </Card>
          )}
        </>
      )}

      {tab === "monitoring" && (
        metrics.length === 0 ? (
          <Card style={{ padding: 16 }}><EmptyState>{t("servers.noMetrics")}</EmptyState></Card>
        ) : (
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            <MetricChart data={cpu} label={t("servers.cpu")} unit="%" color="var(--c-a)" />
            <MetricChart data={ram} label={t("servers.ram")} unit="%" color="var(--c-lapis)" />
            <MetricChart data={netIn.data} label={t("servers.netIn")} unit={" " + netIn.unit} color="var(--c-g)" decimals={1} />
            <MetricChart data={netOut.data} label={t("servers.netOut")} unit={" " + netOut.unit} color="var(--c-am)" decimals={1} />
          </div>
        )
      )}

      {tab === "updates" && server.canWrite && <PatchCard id={id} />}

      {tab === "drains" && server.canWrite && <LogDrainCard id={id} />}

      {tab === "maintenance" && (
        <>
          <TagsCard tags={server.tags} canWrite={server.canWrite} onSave={(next) => tags.mutate(next)} />
          <ProxyCard id={id} canWrite={server.canWrite} />
          {server.canWrite && <NetworkCard id={id} server={server} />}
          {server.canWrite && <CleanupCard id={id} server={server} />}
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
            <div style={{ fontSize: 12, color: "var(--c-am)", marginBottom: 10 }}>⚠ {t("patching.rebootRequired")}</div>
          )}
          {info.count === 0 ? (
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
                    <span className="mono" style={{ color: "var(--c-tx3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.current} → {p.candidate}</span>
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

function NetworkCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  const [wildcard, setWildcard] = useState("");
  const [suffix, setSuffix] = useState("");
  const [publicIp, setPublicIp] = useState("");
  useEffect(() => {
    setWildcard(server.wildcardDomain ?? "");
    setSuffix(server.magicSuffix ?? "");
    setPublicIp(server.ipSource === "manual" ? (server.publicIp ?? "") : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const save = useMutation({
    mutationFn: () => {
      const cfg: { wildcardDomain: string | null; magicSuffix: string | null; publicIp?: string | null } = {
        wildcardDomain: wildcard.trim() || null,
        magicSuffix: suffix.trim() || null,
      };
      const ip = publicIp.trim();
      // Only touch the IP pin on a deliberate change: a typed IP pins it (manual),
      // and emptying the field clears an EXISTING manual pin. For an auto-detected
      // IP the field is left empty as a placeholder — don't send it, or Save would
      // wipe the observed address.
      if (ip) cfg.publicIp = ip;
      else if (server.ipSource === "manual") cfg.publicIp = null;
      return api.setServerNetwork(id, cfg);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["server", id] }),
  });

  return (
    <Card style={{ padding: 16, marginTop: 20 }}>
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
        <div>
          <Btn variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>{t("servers.save")}</Btn>
        </div>
      </div>
    </Card>
  );
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
            <Btn variant="ghost" onClick={() => start.mutate()} disabled={busy}>{t("servers.proxyStart")}</Btn>
            <Btn variant="ghost" onClick={() => restart.mutate()} disabled={busy}>{t("servers.proxyRestart")}</Btn>
            <Btn variant="ghost" onClick={() => stop.mutate()} disabled={busy}>{t("servers.proxyStop")}</Btn>
          </>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("servers.proxyDesc")}</p>
      <Btn variant="ghost" onClick={() => viewLogs.mutate()} disabled={viewLogs.isPending}>
        {viewLogs.isPending ? "…" : t("servers.proxyViewLogs")}
      </Btn>
      <button onClick={refresh} style={{ marginLeft: 8, background: "transparent", border: "none", color: "var(--c-tx3)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>↻</button>
      {logs && (
        <pre className="mono" style={{ margin: "10px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", background: "var(--c-el)", padding: 10, borderRadius: "var(--r1)" }}>{logs}</pre>
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

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
