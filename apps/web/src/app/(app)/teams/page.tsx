"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { api, teamIconUrl } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function TeamsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: teams = [], isLoading, isError, refetch } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: invites = [] } = useQuery({ queryKey: ["myInvitations"], queryFn: () => api.myInvitations() });

  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createTeam(name),
    onSuccess: () => { setName(""); qc.invalidateQueries({ queryKey: ["teams"] }); },
  });
  const respond = useMutation({
    mutationFn: ({ token, accept }: { token: string; accept: boolean }) =>
      accept ? api.acceptInvitation(token) : api.declineInvitation(token),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["myInvitations"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
    },
  });

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("teams.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("teams.subtitle")}</p>

      {invites.length > 0 && (
        <Card style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("teams.yourInvitations")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {invites.map((inv) => (
              <div key={inv.token} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{inv.teamName}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: 8 }}>{t("teams.invitedAs", { role: inv.role })}</span>
                </div>
                <Btn onClick={() => respond.mutate({ token: inv.token, accept: true })} disabled={respond.isPending}>{t("teams.accept")}</Btn>
                <Btn variant="ghost" onClick={() => respond.mutate({ token: inv.token, accept: false })} disabled={respond.isPending}>{t("teams.decline")}</Btn>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form onSubmit={(e) => { e.preventDefault(); if (name && !create.isPending) create.mutate(); }} style={{ display: "flex", gap: 8 }}>
          <input style={{ ...field, flex: 1 }} placeholder={t("teams.name")} aria-label={t("teams.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <Btn type="submit" disabled={create.isPending || !name}>{t("teams.create")}</Btn>
        </form>
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isError && teams.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {teams.map((tm) => (
            <Link key={tm.id} href={`/teams/${tm.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
              <span style={{ width: 32, height: 32, borderRadius: 8, background: "var(--c-tile)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
                {teamIconUrl(tm.id, tm.iconUpdatedAt) ? (
                  <img src={teamIconUrl(tm.id, tm.iconUpdatedAt)!} alt="" width={32} height={32} style={{ objectFit: "cover" }} />
                ) : (
                  <Users size={16} color="var(--c-a)" />
                )}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{tm.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("teams.members", { n: tm.memberCount ?? 0 })}</div>
              </div>
              <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{tm.role}</span>
            </Link>
          ))}
          {teams.length === 0 && (
            <EmptyState icon={Users} title={t("teams.emptyTitle")}>{t("teams.empty")}</EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
