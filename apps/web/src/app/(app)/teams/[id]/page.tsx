"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import type { Role, TeamMember, Project, TeamRole } from "../../../../lib/types";
import { TEAM_PERMISSIONS } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { IconBtn } from "../../../../components/icon-btn";
import { useConfirm } from "../../../../components/confirm";

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
  const confirm = useConfirm();

  const { data: team, isLoading: teamLoading, isError } = useQuery({ queryKey: ["team", id], queryFn: () => api.getTeam(id), retry: false });
  const canManage = team?.role === "OWNER" || team?.role === "ADMIN";
  const isOwner = team?.role === "OWNER";

  const { data: members = [] } = useQuery({ queryKey: ["teamMembers", id], queryFn: () => api.listTeamMembers(id) });
  const { data: teamRoles = [] } = useQuery({ queryKey: ["teamRoles", id], queryFn: () => api.listTeamRoles(id), enabled: canManage });
  const { data: allProjects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects(), enabled: canManage });
  const teamProjects = allProjects.filter((p) => p.teamId === id);
  const { data: invitations = [] } = useQuery({
    queryKey: ["teamInvitations", id],
    queryFn: () => api.listTeamInvitations(id),
    enabled: canManage,
  });

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ["teamMembers", id] });
    qc.invalidateQueries({ queryKey: ["teamInvitations", id] });
    qc.invalidateQueries({ queryKey: ["teamRoles", id] });
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
    mutationFn: ({ userId, assignment }: { userId: string; assignment: { role: Role } | { teamRoleId: string } }) =>
      api.setTeamMemberRole(id, userId, assignment),
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

  if (teamLoading) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;
  if (isError || !team) {
    return (
      <div style={{ padding: "var(--page-pad)" }}>
        <PageHeader breadcrumb={[{ label: t("nav.teams"), href: "/teams" }, { label: t("teams.notFound") }]} title={t("teams.notFound")} />
        <Card style={{ padding: 16 }}><EmptyState>{t("teams.notFoundDesc")}</EmptyState></Card>
      </div>
    );
  }
  const ownerCount = members.filter((m) => m.role === "OWNER").length;
  const inviteLink = lastToken ? `${typeof location !== "undefined" ? location.origin : ""}/invite/${lastToken}` : "";

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={[{ label: t("nav.teams"), href: "/teams" }, { label: team.name }]}
        title={team.name}
        badge={<Badge tone={isOwner ? "gold" : "muted"}>{team.role}</Badge>}
        actions={isOwner ? <Btn variant="danger" onClick={async () => { if (await confirm({ title: t("teams.deleteTeam"), body: t("teams.deleteConfirm"), danger: true, confirmText: team.name })) del.mutate(); }}>{t("teams.deleteTeam")}</Btn> : undefined}
      />
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
              <div key={m.userId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13 }}>{m.email}</span>
                    {m.name && <span style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: 8 }}>{m.name}</span>}
                  </div>
                  {canManage && !lastOwner ? (
                    <select
                      style={field}
                      value={m.teamRoleId ?? m.role}
                      onChange={(e) => {
                        const v = e.target.value;
                        const builtin = v === "OWNER" || v === "ADMIN" || v === "VIEWER";
                        setRole.mutate({ userId: m.userId, assignment: builtin ? { role: v as Role } : { teamRoleId: v } });
                      }}
                    >
                      <option value="VIEWER">VIEWER</option>
                      <option value="ADMIN">ADMIN</option>
                      {isOwner && <option value="OWNER">OWNER</option>}
                      {teamRoles.length > 0 && (
                        <optgroup label={t("teams.customRole")}>
                          {teamRoles.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{m.roleName ?? m.role}</span>
                  )}
                  {canManage && !lastOwner && (
                    <IconBtn label={t("common.remove")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) removeMember.mutate(m.userId); }}>×</IconBtn>
                  )}
                </div>
                {canManage && m.role === "VIEWER" && !m.teamRoleId && (
                  <MemberAccessEditor teamId={id} member={m} projects={teamProjects} onSaved={refetch} />
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
                  <button onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) revoke.mutate(inv.id); }} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}>{t("teams.revoke")}</button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {canManage && <RolesCard teamId={id} roles={teamRoles} onChanged={refetch} />}
    </div>
  );
}

/** Create / edit / delete a team's custom roles as a checkbox grid of granular permissions. */
function RolesCard({ teamId, roles, onChanged }: { teamId: string; roles: TeamRole[]; onChanged: () => void }) {
  const t = useT();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null); // role id being edited, or null (create)

  const reset = () => { setName(""); setPerms(new Set()); setEditing(null); };
  const startEdit = (r: TeamRole) => { setEditing(r.id); setName(r.name); setPerms(new Set(r.permissions)); };
  const toggle = (p: string) => setPerms((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.updateTeamRole(teamId, editing, { name: name.trim(), permissions: [...perms] })
        : api.createTeamRole(teamId, { name: name.trim(), permissions: [...perms] }),
    onSuccess: () => { reset(); onChanged(); },
  });
  const del = useMutation({ mutationFn: (roleId: string) => api.deleteTeamRole(teamId, roleId), onSuccess: onChanged });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("teams.rolesTitle")}</div>

      {roles.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
          {roles.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
              <span style={{ flex: 1, fontSize: 11, color: "var(--c-tx3)" }}>
                {r.permissions.length ? r.permissions.map((p) => t(`teams.perm_${p.replace(":", "_")}`)).join(", ") : t("teams.noPermissions")}
              </span>
              <button onClick={() => startEdit(r)} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}>{t("teams.editRole")}</button>
              <IconBtn label={t("teams.deleteRole")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(r.id); }}>×</IconBtn>
            </div>
          ))}
        </div>
      )}

      <div style={{ borderTop: roles.length ? "1px solid var(--c-bd)" : "none", paddingTop: roles.length ? 12 : 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{editing ? t("teams.editRole") : t("teams.addRole")}</div>
        <input style={{ ...field, width: "100%", marginBottom: 10, boxSizing: "border-box" }} placeholder={t("teams.roleName")} value={name} onChange={(e) => setName(e.target.value)} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6, marginBottom: 12 }}>
          {TEAM_PERMISSIONS.map((p) => (
            <label key={p} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx2)", cursor: "pointer" }}>
              <input type="checkbox" checked={perms.has(p)} onChange={() => toggle(p)} />
              {t(`teams.perm_${p.replace(":", "_")}`)}
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>{save.isPending ? "…" : editing ? t("common.save") : t("teams.addRole")}</Btn>
          {editing && <Btn variant="ghost" onClick={reset}>{t("common.cancel")}</Btn>}
        </div>
        {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(save.error as Error).message}</div>}
      </div>
    </Card>
  );
}

/** Per-member access scoping: restrict a VIEWER to a chosen set of the team's projects. */
function MemberAccessEditor({
  teamId,
  member,
  projects,
  onSaved,
}: {
  teamId: string;
  member: TeamMember;
  projects: Project[];
  onSaved: () => void;
}) {
  const t = useT();
  const [restricted, setRestricted] = useState(member.restrictedAccess);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(member.accessedProjects));
  const toggle = (pid: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(pid)) n.delete(pid);
      else n.add(pid);
      return n;
    });
  const save = useMutation({
    mutationFn: () =>
      api.setTeamMemberAccess(teamId, member.userId, { restrictedAccess: restricted, accessedProjects: [...selected] }),
    onSuccess: onSaved,
  });
  return (
    <div style={{ marginLeft: 12, padding: "8px 12px", background: "var(--c-el)", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx2)" }}>
        <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
        {t("teams.restrictAccess")}
      </label>
      {restricted && (
        <>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 4px" }}>{t("teams.accessDesc")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
            {projects.length === 0 && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("teams.noProjects")}</span>}
            {projects.map((p) => (
              <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--c-tx2)" }}>
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                {p.name}
              </label>
            ))}
          </div>
        </>
      )}
      <Btn variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>{t("teams.saveAccess")}</Btn>
      {save.isSuccess && <span style={{ fontSize: 11, color: "var(--c-g)", marginLeft: 8 }}>{t("teams.accessSaved")}</span>}
    </div>
  );
}
