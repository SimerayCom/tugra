"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { pct, fmtBytesStr, formatUptime } from "../../../../lib/fleet";
import type { ServerView } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { MetricChart } from "../../../../components/charts";
import { TerminalModal } from "../../../../components/terminal-modal";
import { TagsCard } from "../../../../components/tags";
import { BackLink, Badge, Btn, Card, Spinner, StatusDot } from "../../../../components/ui";
import { usePatchLogStream } from "../../../../hooks/useDeployLogStream";

export default function ServerDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();

  const { data: server, isLoading } = useQuery({
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
    refetchInterval: 5000,
  });
  const [shellOpen, setShellOpen] = useState(false);

  if (isLoading || !server) return <div style={{ padding: 28 }}><Spinner /></div>;

  const cpu = metrics.map((m) => m.cpu);
  const ram = metrics.map((m) => pct(m.memUsed, m.memTotal));

  return (
    <div style={{ padding: 28 }}>
      <BackLink href="/servers" label={t("common.backTo", { target: t("nav.servers") })} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <StatusDot status={server.status} />
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{server.name}</h1>
        <Badge tone={server.canWrite ? "gold" : "muted"}>{server.role}</Badge>
      </div>
      <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: "0 0 20px" }}>
        {server.hostname ?? "—"} · {server.status}
      </p>

      <Card style={{ padding: 16, marginBottom: 20, display: "flex", gap: 28, flexWrap: "wrap" }}>
        <Info label={t("servers.status")} value={server.status} />
        <Info label={t("servers.team")} value={server.teamId.slice(0, 8)} />
        <Info label={t("servers.sealLabel")} value={server.seal ? t("servers.sealed") : "—"} />
        <Info label={t("servers.lastSeen")} value={server.lastSeenAt ? new Date(server.lastSeenAt).toLocaleTimeString() : "—"} />
      </Card>

      {(server.os || server.arch || server.cpuCores) && (
        <Card style={{ padding: 16, marginBottom: 20, display: "flex", gap: 28, flexWrap: "wrap" }}>
          <Info label={t("servers.os")} value={server.os ? `${server.os} ${server.osVersion ?? ""}`.trim() : "—"} />
          <Info label={t("servers.arch")} value={server.arch ?? "—"} />
          <Info label={t("servers.kernel")} value={server.kernel ?? "—"} />
          <Info label={t("servers.cpuCores")} value={server.cpuCores != null ? String(server.cpuCores) : "—"} />
          <Info label={t("servers.ramTotal")} value={fmtBytesStr(server.memTotalBytes)} />
          <Info label={t("servers.uptime")} value={formatUptime(server.uptimeSeconds)} />
        </Card>
      )}

      {metrics.length === 0 ? (
        <Card style={{ padding: 24, color: "var(--c-tx3)" }}>{t("servers.noMetrics")}</Card>
      ) : (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr" }}>
          <MetricChart data={cpu} label={t("servers.cpu")} unit="%" color="var(--c-a)" />
          <MetricChart data={ram} label={t("servers.ram")} unit="%" color="var(--c-lapis)" />
        </div>
      )}

      {server.canWrite && (
        <div style={{ marginBottom: 20 }}>
          <Btn variant="ghost" onClick={() => setShellOpen(true)}>{t("servers.openHostShell")}</Btn>
        </div>
      )}

      <TagsCard tags={server.tags} canWrite={server.canWrite} onSave={(next) => tags.mutate(next)} />

      {server.canWrite && <PatchCard id={id} />}

      {server.canWrite && <LogDrainCard id={id} />}

      {server.canWrite && <CleanupCard id={id} server={server} />}

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
            <button onClick={() => del.mutate(d.id)} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", cursor: "pointer", padding: "4px 9px", fontFamily: "inherit" }}>×</button>
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
