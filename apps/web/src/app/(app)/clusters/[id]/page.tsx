"use client";

import React, { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../../components/ui";
import { ErrorState } from "../../../../components/error-state";
import { Modal } from "../../../../components/modal";
import { TextInput } from "../../../../components/form";
import { useConfirm } from "../../../../components/confirm";
import { useToast } from "../../../../components/toast";
import { BulkRunModal } from "../../../../components/bulk-run-modal";
import type { ClusterDetail, SwarmStatus } from "../../../../lib/types";

const SWARM_COLOR: Record<SwarmStatus, string> = {
  NONE: "var(--c-tx3)",
  FORMING: "var(--c-am)",
  ACTIVE: "var(--c-g)",
  DEGRADED: "var(--c-am)",
  DISSOLVING: "var(--c-am)",
};

function StatCard({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <Card style={{ padding: 16, flex: "1 1 160px", minWidth: 0 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: warn ? "var(--c-r)" : "var(--c-tx3)", marginTop: 2 }}>{sub}</div>}
    </Card>
  );
}

export default function ClusterDetailPage() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const id = String(useParams().id);

  const { data: cluster, isLoading, isError, refetch } = useQuery({ queryKey: ["cluster", id], queryFn: () => api.getCluster(id) });
  const [managing, setManaging] = useState(false);
  const [running, setRunning] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [forming, setForming] = useState(false);

  const { data: swarm, isLoading: swarmLoading, refetch: refetchSwarm, isRefetching: swarmRefetching } = useQuery({
    queryKey: ["swarm", id],
    queryFn: () => api.getSwarmStatus(id),
  });
  const dissolve = useMutation({
    mutationFn: () => api.dissolveSwarm(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["swarm", id] }); qc.invalidateQueries({ queryKey: ["cluster", id] }); },
    onError: (e) => toast(e instanceof Error ? e.message : t("clusters.swarmActionFailed"), "error"),
  });

  const del = useMutation({
    mutationFn: () => api.deleteCluster(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["clusters"] }); router.replace("/clusters"); },
    onError: (e) => toast(e instanceof Error ? e.message : t("clusters.deleteFailed"), "error"),
  });

  if (isLoading) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;
  if (isError || !cluster) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;

  const h = cluster.health;
  const memberIds = cluster.servers.map((s) => s.id);

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{cluster.name}</h1>
          {cluster.description && <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "4px 0 0" }}>{cluster.description}</p>}
        </div>
        {cluster.canWrite && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => setRenaming(true)}>{t("clusters.rename")}</Btn>
            <Btn
              variant="danger"
              disabled={del.isPending}
              onClick={async () => {
                if (await confirm({ body: t("clusters.deleteConfirm"), danger: true })) del.mutate();
              }}
            >
              {t("clusters.delete")}
            </Btn>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <StatCard
          label={t("clusters.nodes")}
          value={`${h.nodes.online}/${h.nodes.total}`}
          sub={h.nodes.offline > 0 ? t("clusters.offlineWarn", { n: h.nodes.offline }) : t("clusters.nodesOnline", { online: h.nodes.online, total: h.nodes.total })}
          warn={h.nodes.offline > 0}
        />
        <StatCard label={t("clusters.apps")} value={`${h.apps.running}/${h.apps.total}`} sub={t("clusters.appsRunning", { running: h.apps.running, total: h.apps.total })} />
      </div>

      <Card style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>{t("clusters.members")}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {memberIds.length > 0 && <Btn variant="ghost" onClick={() => setRunning(true)}>{t("clusters.runCommand")}</Btn>}
            {cluster.canWrite && <Btn onClick={() => setManaging(true)}>{t("clusters.manageMembers")}</Btn>}
          </div>
        </div>
        {cluster.servers.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("clusters.noMembers")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {cluster.servers.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: s.status === "ONLINE" ? "var(--c-g)" : s.status === "OFFLINE" ? "var(--c-r)" : "var(--c-am)" }} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                {s.publicIp && <span className="mono" style={{ fontSize: 12, color: "var(--c-tx3)" }}>{s.publicIp}</span>}
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--c-tx3)" }}>{s.status}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card style={{ padding: 18, marginTop: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600 }}>{t("clusters.swarm")}</div>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 2 }}>{t("clusters.swarmHint")}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {swarm && swarm.swarmStatus !== "NONE" && (
              <Btn variant="ghost" disabled={swarmRefetching} onClick={() => refetchSwarm()}>{t("clusters.refresh")}</Btn>
            )}
            {cluster.canWrite && swarm?.swarmStatus === "NONE" && memberIds.length > 0 && (
              <Btn onClick={() => setForming(true)}>{t("clusters.formSwarm")}</Btn>
            )}
            {cluster.canWrite && swarm && swarm.swarmStatus !== "NONE" && (
              <Btn
                variant="danger"
                disabled={dissolve.isPending}
                onClick={async () => {
                  if (await confirm({ body: t("clusters.dissolveConfirm"), danger: true })) dissolve.mutate();
                }}
              >
                {t("clusters.dissolveSwarm")}
              </Btn>
            )}
          </div>
        </div>
        {swarmLoading || !swarm ? (
          <Spinner />
        ) : swarm.swarmStatus === "NONE" ? (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("clusters.swarmNone")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: SWARM_COLOR[swarm.swarmStatus] }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: SWARM_COLOR[swarm.swarmStatus] }} />
                {swarm.swarmStatus}
              </span>
              {swarm.managerServerId && (
                <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>
                  {t("clusters.swarmManager")}: {cluster.servers.find((s) => s.id === swarm.managerServerId)?.name ?? swarm.managerServerId}
                </span>
              )}
            </div>
            {swarm.swarmLastError && (
              <div style={{ fontSize: 12, color: "var(--c-am)", background: "var(--c-bg2)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 10px" }}>
                {swarm.swarmLastError}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {swarm.nodes.map((n) => (
                <div key={n.serverId} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: n.swarmRole === "MANAGER" ? "var(--c-a)" : n.swarmRole === "WORKER" ? "var(--c-tx2)" : "var(--c-tx3)", minWidth: 60 }}>
                    {n.swarmRole ?? "—"}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{n.name}</span>
                  {n.swarmError && <span style={{ fontSize: 12, color: "var(--c-r)" }}>{n.swarmError}</span>}
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--c-tx3)" }}>{n.status}</span>
                </div>
              ))}
            </div>
            {swarm.live && swarm.live.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>
                {t("clusters.swarmLive")}: {swarm.live.map((l) => `${l.hostname} (${l.role}/${l.state})`).join(", ")}
              </div>
            )}
          </div>
        )}
      </Card>

      {managing && <ManageMembersModal cluster={cluster} onClose={() => setManaging(false)} />}
      {renaming && <RenameModal cluster={cluster} onClose={() => setRenaming(false)} />}
      {running && <ClusterRunModal cluster={cluster} memberIds={memberIds} onClose={() => setRunning(false)} />}
      {forming && <FormSwarmModal cluster={cluster} onClose={() => setForming(false)} />}
    </div>
  );
}

function ManageMembersModal({ cluster, onClose }: { cluster: ClusterDetail; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: allServers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const teamServers = allServers.filter((s) => s.teamId === cluster.teamId);
  const [selected, setSelected] = useState<Set<string>>(new Set(cluster.servers.map((s) => s.id)));
  const save = useMutation({
    mutationFn: () => api.setClusterServers(cluster.id, [...selected]),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cluster", cluster.id] }); qc.invalidateQueries({ queryKey: ["clusters"] }); onClose(); },
  });
  const toggle = (sid: string) => setSelected((prev) => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });

  return (
    <Modal onClose={onClose} cardStyle={{ width: 460, maxWidth: "92vw" }}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>{t("clusters.manageMembers")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "50vh", overflowY: "auto" }}>
        {teamServers.map((s) => (
          <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "6px 8px", borderRadius: "var(--r1)", fontSize: 13 }}>
            <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} style={{ accentColor: "var(--c-a)" }} />
            <span style={{ fontWeight: 600 }}>{s.name}</span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--c-tx3)" }}>{s.status}</span>
          </label>
        ))}
      </div>
      {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{save.error instanceof Error ? save.error.message : t("clusters.saveMembersFailed")}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "…" : t("clusters.saveMembers")}</Btn>
      </div>
    </Modal>
  );
}

function RenameModal({ cluster, onClose }: { cluster: ClusterDetail; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(cluster.name);
  const [description, setDescription] = useState(cluster.description ?? "");
  const save = useMutation({
    mutationFn: () => api.updateCluster(cluster.id, { name: name.trim(), description: description.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cluster", cluster.id] }); qc.invalidateQueries({ queryKey: ["clusters"] }); onClose(); },
  });
  return (
    <Modal onClose={onClose}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>{t("clusters.rename")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("clusters.descriptionPlaceholder")} />
      </div>
      {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{save.error instanceof Error ? save.error.message : t("clusters.renameFailed")}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>{save.isPending ? "…" : t("clusters.saveMembers")}</Btn>
      </div>
    </Modal>
  );
}

/** Reuses the fleet BulkRunModal, pre-targeted to the cluster's member servers. While the server list
 *  loads (or if it fails) we render a small modal instead of nothing — so the action is never a dead end. */
function ClusterRunModal({ cluster, memberIds, onClose }: { cluster: ClusterDetail; memberIds: string[]; onClose: () => void }) {
  const t = useT();
  const { data: allServers, isLoading, isError, refetch } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  if (isLoading || isError || !allServers) {
    return (
      <Modal onClose={onClose}>
        {isError ? <ErrorState onRetry={() => refetch()} /> : <Spinner />}
      </Modal>
    );
  }
  return <BulkRunModal servers={allServers.filter((s) => s.teamId === cluster.teamId)} selectedIds={memberIds} onClose={onClose} />;
}

/** Pick a manager (from the online members) and optionally override the advertise address, then form the
 *  swarm. Every other online member joins as a worker. */
function FormSwarmModal({ cluster, onClose }: { cluster: ClusterDetail; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const online = cluster.servers.filter((s) => s.status === "ONLINE");
  const [managerServerId, setManagerServerId] = useState(online[0]?.id ?? "");
  const [advertiseAddr, setAdvertiseAddr] = useState("");
  const form = useMutation({
    mutationFn: () => api.formSwarm(cluster.id, { managerServerId, advertiseAddr: advertiseAddr.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swarm", cluster.id] });
      qc.invalidateQueries({ queryKey: ["cluster", cluster.id] });
      onClose();
    },
  });
  return (
    <Modal onClose={onClose} cardStyle={{ width: 460, maxWidth: "92vw" }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("clusters.formSwarm")}</div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("clusters.formSwarmHint")}</div>
      <label style={{ fontSize: 12, fontWeight: 600 }}>{t("clusters.swarmManager")}</label>
      <select
        value={managerServerId}
        onChange={(e) => setManagerServerId(e.target.value)}
        style={{ width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", background: "var(--c-bg)", color: "var(--c-tx)" }}
      >
        {online.length === 0 && <option value="">{t("clusters.noOnlineMembers")}</option>}
        {online.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      <div style={{ marginTop: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600 }}>{t("clusters.advertiseAddr")}</label>
        <TextInput value={advertiseAddr} onChange={(e) => setAdvertiseAddr(e.target.value)} placeholder={t("clusters.advertiseAddrPlaceholder")} />
      </div>
      <div style={{ fontSize: 11, color: "var(--c-am)", marginTop: 10 }}>{t("clusters.swarmPortsWarn")}</div>
      {form.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{form.error instanceof Error ? form.error.message : t("clusters.swarmActionFailed")}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn onClick={() => form.mutate()} disabled={form.isPending || !managerServerId}>{form.isPending ? "…" : t("clusters.formSwarm")}</Btn>
      </div>
    </Modal>
  );
}
