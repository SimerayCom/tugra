"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import type { Role } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn, Card, Spinner } from "../../../../components/ui";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function TeamDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();

  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const team = teams.find((x) => x.id === id);
  const canManage = team?.role === "OWNER" || team?.role === "ADMIN";
  const isOwner = team?.role === "OWNER";

  const { data: members = [], isLoading } = useQuery({ queryKey: ["teamMembers", id], queryFn: () => api.listTeamMembers(id) });
  const { data: invitations = [] } = useQuery({
    queryKey: ["teamInvitations", id],
    queryFn: () => api.listTeamInvitations(id),
    enabled: canManage,
  });

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ["teamMembers", id] });
    qc.invalidateQueries({ queryKey: ["teamInvitations", id] });
    qc.invalidateQueries({ queryKey: ["teams"] });
  };

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("VIEWER");
  const [lastToken, setLastToken] = useState("");
  const invite = useMutation({
    mutationFn: () => api.inviteTeamMember(id, email, inviteRole),
    onSuccess: (inv) => { setEmail(""); setLastToken(inv.token); refetch(); },
  });
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => api.setTeamMemberRole(id, userId, role),
    onSuccess: refetch,
  });
  const removeMember = useMutation({ mutationFn: (userId: string) => api.removeTeamMember(id, userId), onSuccess: refetch });
  const revoke = useMutation({ mutationFn: (invId: string) => api.revokeTeamInvitation(id, invId), onSuccess: refetch });
  const del = useMutation({ mutationFn: () => api.deleteTeam(id), onSuccess: () => router.replace("/teams") });
  const [newName, setNewName] = useState("");
  const rename = useMutation({
    mutationFn: () => api.renameTeam(id, newName),
    onSuccess: () => { setNewName(""); qc.invalidateQueries({ queryKey: ["teams"] }); },
  });

  if (isLoading || !team) return <div style={{ padding: 28 }}><Spinner /></div>;
  const ownerCount = members.filter((m) => m.role === "OWNER").length;
  const inviteLink = lastToken ? `${typeof location !== "undefined" ? location.origin : ""}/teams?invite=${lastToken}` : "";

  return (
    <div style={{ padding: 28 }}>
      <BackLink href="/teams" label={t("common.backTo", { target: t("nav.teams") })} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{team.name}</h1>
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{team.role}</span>
        <div style={{ flex: 1 }} />
        {isOwner && (
          <Btn variant="danger" onClick={() => { if (confirm(t("teams.deleteConfirm"))) del.mutate(); }}>{t("teams.deleteTeam")}</Btn>
        )}
      </div>
      {del.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 12 }}>{(del.error as Error).message}</div>}

      {canManage && (
        <Card style={{ padding: 16, marginBottom: 16 }}>
          <form onSubmit={(e) => { e.preventDefault(); rename.mutate(); }} style={{ display: "flex", gap: 8 }}>
            <input style={{ ...field, flex: 1 }} placeholder={team.name} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Btn onClick={() => rename.mutate()} disabled={rename.isPending || !newName}>{t("teams.rename")}</Btn>
          </form>
        </Card>
      )}

      <Card style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("teams.membersTitle")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {members.map((m) => {
            const lastOwner = m.role === "OWNER" && ownerCount <= 1;
            return (
              <div key={m.userId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 13 }}>{m.email}</span>
                  {m.name && <span style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: 8 }}>{m.name}</span>}
                </div>
                {canManage && !lastOwner ? (
                  <select style={field} value={m.role} onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value as Role })}>
                    <option value="VIEWER">VIEWER</option>
                    <option value="ADMIN">ADMIN</option>
                    {isOwner && <option value="OWNER">OWNER</option>}
                  </select>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{m.role}</span>
                )}
                {canManage && !lastOwner && (
                  <button onClick={() => removeMember.mutate(m.userId)} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", cursor: "pointer", padding: "4px 9px", fontFamily: "inherit" }}>×</button>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {canManage && (
        <Card style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("teams.invite")}</div>
          <form onSubmit={(e) => { e.preventDefault(); invite.mutate(); }} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input style={{ ...field, flex: 1, minWidth: 180 }} type="email" placeholder={t("teams.inviteEmail")} value={email} onChange={(e) => setEmail(e.target.value)} required />
            <select style={field} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
              <option value="VIEWER">VIEWER</option>
              <option value="ADMIN">ADMIN</option>
              {isOwner && <option value="OWNER">OWNER</option>}
            </select>
            <Btn onClick={() => invite.mutate()} disabled={invite.isPending || !email}>{t("teams.invite")}</Btn>
          </form>
          {invite.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(invite.error as Error).message}</div>}
          {lastToken && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--c-am)" }}>
              {t("teams.inviteSent")}
              <div className="mono" style={{ fontSize: 11, color: "var(--c-tx2)", marginTop: 4, wordBreak: "break-all" }}>{inviteLink}</div>
            </div>
          )}

          {invitations.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("teams.pendingInvitations")}</div>
              {invitations.map((inv) => (
                <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ flex: 1, fontSize: 13 }}>{inv.email}</span>
                  <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{inv.role}</span>
                  <button onClick={() => revoke.mutate(inv.id)} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}>{t("teams.revoke")}</button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
