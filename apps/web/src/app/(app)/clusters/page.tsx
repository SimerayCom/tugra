"use client";

import Link from "next/link";
import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useTeamScope } from "../../../components/team-scope";
import { scopeByTeam } from "../../../lib/team-scope";
import { Btn, Card, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { Modal } from "../../../components/modal";
import { Field, TextInput } from "../../../components/form";

const selectStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
};

export default function ClustersPage() {
  const t = useT();
  const { teamId } = useTeamScope();
  const { data: clusters, isLoading, isError, refetch } = useQuery({ queryKey: ["clusters"], queryFn: () => api.listClusters() });
  const [creating, setCreating] = useState(false);
  const scoped = scopeByTeam(clusters ?? [], teamId);

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{t("clusters.title")}</h1>
          <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "4px 0 0", maxWidth: 520 }}>{t("clusters.subtitle")}</p>
        </div>
        <Btn onClick={() => setCreating(true)}>{t("clusters.new")}</Btn>
      </div>
      {isLoading && <Spinner />}
      {isError && !clusters && <ErrorState onRetry={() => refetch()} />}
      {clusters && scoped.length === 0 && (
        <Card style={{ padding: 24, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("clusters.empty")}</Card>
      )}
      {clusters && scoped.length > 0 && (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {scoped.map((c) => (
            <Link key={c.id} href={`/clusters/${c.id}`} style={{ textDecoration: "none" }}>
              <Card style={{ padding: 16, height: "100%" }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "var(--c-tx)" }}>{c.name}</div>
                {c.description && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 4 }}>{c.description}</div>}
                <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 10 }}>{t("clusters.nodeCount", { n: c.nodeCount })}</div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      {creating && <CreateClusterModal defaultTeamId={teamId} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateClusterModal({ defaultTeamId, onClose }: { defaultTeamId: string | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [teamId, setTeamId] = useState(defaultTeamId ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const effectiveTeam = teamId || teams[0]?.id || "";
  const create = useMutation({
    mutationFn: () => api.createCluster({ teamId: effectiveTeam, name: name.trim(), description: description.trim() || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["clusters"] }); onClose(); },
  });

  return (
    <Modal onClose={onClose} ariaLabel={t("clusters.new")}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>{t("clusters.new")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {teams.length > 1 && (
          <Field label={t("clusters.team")} htmlFor="cl-team">
            <select id="cl-team" value={effectiveTeam} onChange={(e) => setTeamId(e.target.value)} style={selectStyle}>
              {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </select>
          </Field>
        )}
        <Field label={t("clusters.name")} htmlFor="cl-name">
          <TextInput id="cl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("clusters.namePlaceholder")} autoFocus />
        </Field>
        <Field label={t("clusters.description")} htmlFor="cl-desc">
          <TextInput id="cl-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("clusters.descriptionPlaceholder")} />
        </Field>
      </div>
      {create.isError && (
        <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>
          {create.error instanceof Error ? create.error.message : t("clusters.createFailed")}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn onClick={() => create.mutate()} disabled={create.isPending || !name.trim() || !effectiveTeam}>
          {create.isPending ? "…" : t("clusters.create")}
        </Btn>
      </div>
    </Modal>
  );
}
