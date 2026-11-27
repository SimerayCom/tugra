"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { api, teamIconUrl } from "../../../../lib/api";
import type { ClientAccess, Role, TeamMember, Project, TeamRole } from "../../../../lib/types";
import { TEAM_PERMISSIONS } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { useToast } from "../../../../components/toast";
import { Badge, Btn, Card, EmptyState, Spinner, Working, ActivitySpinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { IconBtn } from "../../../../components/icon-btn";
import { useConfirm } from "../../../../components/confirm";
import { IdentityCard } from "../../../../components/identity-card";
import { MailNotConfiguredNote } from "../../../../components/mail-not-configured-note";

/** What the invite picker can hold: a built-in role, or one of the two customer-portal presets. */
type InviteChoice = Role | "CLIENT_VIEW" | "CLIENT_DEPLOY";
function clientOf(c: InviteChoice): ClientAccess | null {
  return c === "CLIENT_VIEW" ? "view" : c === "CLIENT_DEPLOY" ? "deploy" : null;
}

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
  const toast = useToast();

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
  // Whether the hub can actually email an invite. Drives honest copy (the invite link is always shown, so
  // invites work without mail; we just don't claim an email was sent when it wasn't).
  const { data: instanceStatus } = useQuery({ queryKey: ["instanceStatus"], queryFn: () => api.getInstanceStatus(), staleTime: 60_000, enabled: canManage });
  const mailOff = instanceStatus?.mailConfigured === false;

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ["teamMembers", id] });
    qc.invalidateQueries({ queryKey: ["teamInvitations", id] });
    qc.invalidateQueries({ queryKey: ["teamRoles", id] });
    qc.invalidateQueries({ queryKey: ["teams"] });
  };

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteChoice>("VIEWER");
  const [lastToken, setLastToken] = useState("");
  const invite = useMutation({
    mutationFn: () => {
      const client = clientOf(inviteRole);
      return client ? api.inviteTeamMember(id, email, "VIEWER", client) : api.inviteTeamMember(id, email, inviteRole as Role);
    },
    onSuccess: (inv) => { setEmail(""); setLastToken(inv.token); refetch(); },
  });
  const setRole = useMutation({
    mutationFn: ({ userId, assignment }: { userId: string; assignment: { role: Role } | { teamRoleId: string } }) =>
      api.setTeamMemberRole(id, userId, assignment),
    onSuccess: refetch,
    meta: { successMessage: t("teams.roleUpdated") },
  });
  // Make a member a Client: make sure the team has the preset, then assign it like any custom role.
  const makeClient = useMutation({
    mutationFn: async ({ userId, access }: { userId: string; access: ClientAccess }) => {
      const role = await api.ensureClientRole(id, access);
      return api.setTeamMemberRole(id, userId, { teamRoleId: role.id });
    },
    onSuccess: refetch,
    meta: { successMessage: t("teams.roleUpdated") },
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.removeTeamMember(id, userId),
    onSuccess: (_r, userId) => { refetch(); toast(t("common.removedNamed", { name: members.find((m) => m.userId === userId)?.email ?? "" }), "success"); },
  });
  const revoke = useMutation({
    mutationFn: (invId: string) => api.revokeTeamInvitation(id, invId),
    onSuccess: (_r, invId) => { refetch(); toast(t("teams.invitationRevoked", { email: invitations.find((i) => i.id === invId)?.email ?? "" }), "success"); },
  });
  const del = useMutation({
    mutationFn: () => api.deleteTeam(id),
    onSuccess: () => { router.replace("/teams"); toast(t("common.deletedNamed", { name: team?.name ?? "" }), "success"); },
  });
  const [newName, setNewName] = useState("");
  const rename = useMutation({
    mutationFn: () => api.renameTeam(id, newName),
    onSuccess: () => {
      setNewName("");
      // The detail page reads ["team", id] and every picker/badge reads ["teams"]: refresh both so the new
      // name shows up at once (title, breadcrumb, team switcher) instead of after a hard reload.
      qc.invalidateQueries({ queryKey: ["team", id] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      toast(t("teams.renamed"), "success");
    },
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
        accent={team.color}
        badge={<Badge tone={isOwner ? "gold" : "muted"}>{team.role}</Badge>}
      />

      {canManage && <div style={{ marginBottom: 16 }}><MailNotConfiguredNote dismissible consequence={t("teams.inviteNoMail")} /></div>}

      <IdentityCard
        name={team.name}
        iconUrl={teamIconUrl(id, team.iconUpdatedAt ?? null)}
        color={team.color ?? null}
        canEdit={canManage}
        fallbackIcon={Users}
        labels={{
          hint: t("teams.iconHint"), upload: t("teams.iconUpload"), replace: t("teams.iconReplace"), remove: t("teams.iconRemove"),
          uploaded: t("teams.iconUploaded"), removed: t("teams.iconRemoved"), tooLarge: t("teams.iconTooLarge"),
          readFailed: t("teams.iconReadFailed"), failed: t("teams.iconFailed"),
        }}
        onSaveIcon={(data) => api.setTeamIcon(id, data)}
        onRemoveIcon={() => api.deleteTeamIcon(id)}
        onSaveColor={(c) => api.setTeamColor(id, c)}
        onChanged={() => { qc.invalidateQueries({ queryKey: ["team", id] }); qc.invalidateQueries({ queryKey: ["teams"] }); }}
      />

      {canManage && (
        <Card style={{ padding: 16, marginBottom: 16 }}>
          <form onSubmit={(e) => { e.preventDefault(); rename.mutate(); }} style={{ display: "flex", gap: 8 }}>
            <input style={{ ...field, flex: 1 }} placeholder={team.name} aria-label={t("teams.rename")} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Btn onClick={() => rename.mutate()} disabled={rename.isPending || !newName}>{t("teams.rename")}</Btn>
          </form>
        </Card>
      )}

      <Card style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("teams.membersTitle")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {members.map((m) => {
            const lastOwner = m.role === "OWNER" && ownerCount <= 1;
            // The role call for this member is running: the select keeps what was picked (not the old role) and locks until it lands.
            const pickedClient = makeClient.isPending && makeClient.variables?.userId === m.userId ? `client:${makeClient.variables.access}` : null;
            const pickedRole = setRole.isPending && setRole.variables?.userId === m.userId ? ("role" in setRole.variables.assignment ? setRole.variables.assignment.role : setRole.variables.assignment.teamRoleId) : null;
            const rolePicked = pickedClient ?? pickedRole;
            return (
              <div key={m.userId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13 }}>{m.email}</span>
                    {m.name && <span style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: 8 }}>{m.name}</span>}
                  </div>
                  {m.clientAccess && <Badge tone="lapis">{t("teams.clientBadge")}</Badge>}
                  {canManage && !lastOwner ? (
                    <select
                      style={field}
                      aria-label={m.email}
                      disabled={rolePicked !== null}
                      aria-busy={rolePicked !== null || undefined}
                      value={rolePicked ?? (m.clientAccess ? `client:${m.clientAccess}` : m.teamRoleId ?? m.role)}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "client:view" || v === "client:deploy") {
                          makeClient.mutate({ userId: m.userId, access: v === "client:deploy" ? "deploy" : "view" });
                          return;
                        }
                        const builtin = v === "OWNER" || v === "ADMIN" || v === "VIEWER";
                        setRole.mutate({ userId: m.userId, assignment: builtin ? { role: v as Role } : { teamRoleId: v } });
                      }}
                    >
                      <option value="VIEWER">VIEWER</option>
                      <option value="ADMIN">ADMIN</option>
                      {isOwner && <option value="OWNER">OWNER</option>}
                      {m.role !== "OWNER" && (
                        <optgroup label={t("teams.clientBadge")}>
                          <option value="client:view">{t("teams.clientView")}</option>
                          <option value="client:deploy">{t("teams.clientDeploy")}</option>
                        </optgroup>
                      )}
                      {teamRoles.some((r) => !r.portal) && (
                        <optgroup label={t("teams.customRole")}>
                          {teamRoles.filter((r) => !r.portal).map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{m.roleName ?? m.role}</span>
                  )}
                  {rolePicked !== null && <Working text={t("teams.roleSaving")} />}
                  {canManage && !lastOwner && (
                    <IconBtn label={t("common.remove")} danger loading={removeMember.isPending && removeMember.variables === m.userId} onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) removeMember.mutate(m.userId); }}>×</IconBtn>
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
            <input style={{ ...field, flex: 1, minWidth: 180 }} type="email" placeholder={t("teams.inviteEmail")} aria-label={t("teams.inviteEmail")} value={email} onChange={(e) => setEmail(e.target.value)} required />
            <select style={field} aria-label={t("teams.invite")} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as InviteChoice)}>
              <option value="VIEWER">VIEWER</option>
              <option value="ADMIN">ADMIN</option>
              {isOwner && <option value="OWNER">OWNER</option>}
              <optgroup label={t("teams.clientBadge")}>
                <option value="CLIENT_VIEW">{t("teams.clientView")}</option>
                <option value="CLIENT_DEPLOY">{t("teams.clientDeploy")}</option>
              </optgroup>
            </select>
            <Btn onClick={() => invite.mutate()} disabled={invite.isPending || !email}>{t("teams.invite")}</Btn>
          </form>
          {clientOf(inviteRole) && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("teams.clientHint")}</div>}
          {invite.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(invite.error as Error).message}</div>}
          {lastToken && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--c-am)" }}>
              {mailOff ? t("teams.inviteCreatedNoMail") : t("teams.inviteSent")}
              <div className="mono" style={{ fontSize: 11, color: "var(--c-tx2)", marginTop: 4, wordBreak: "break-all" }}>{inviteLink}</div>
            </div>
          )}

          {invitations.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("teams.pendingInvitations")}</div>
              {invitations.map((inv) => (
                <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ flex: 1, fontSize: 13 }}>{inv.email}</span>
                  <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{inv.clientAccess ? t("teams.clientBadge") : inv.role}</span>
                  <button disabled={revoke.isPending && revoke.variables === inv.id} aria-busy={(revoke.isPending && revoke.variables === inv.id) || undefined} onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) revoke.mutate(inv.id); }} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>{revoke.isPending && revoke.variables === inv.id && <ActivitySpinner size={10} />}{t("teams.revoke")}</button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {canManage && <RolesCard teamId={id} roles={teamRoles} onChanged={refetch} />}

      {isOwner && (
        <Card style={{ padding: 16, marginTop: 24, border: "1px solid color-mix(in srgb, var(--c-r) 40%, var(--c-bd))" }}>
          <section aria-labelledby="team-danger-zone">
            <h2 id="team-danger-zone" style={{ fontSize: 14, fontWeight: 700, margin: "0 0 4px", color: "var(--c-r)" }}>{t("teams.dangerZone")}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{t("teams.deleteTeam")}</div>
                <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("teams.dangerZoneDesc")}</div>
              </div>
              <Btn variant="danger" disabled={del.isPending} onClick={async () => { if (await confirm({ title: t("teams.deleteTeam"), body: t("teams.deleteConfirm"), danger: true, confirmText: team.name })) del.mutate(); }}>{t("teams.deleteTeam")}</Btn>
            </div>
            {del.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(del.error as Error).message}</div>}
          </section>
        </Card>
      )}
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
              {r.portal && <Badge tone="lapis">{t("teams.clientBadge")}</Badge>}
              <span style={{ flex: 1, fontSize: 11, color: "var(--c-tx3)" }}>
                {r.portal ? t("teams.clientRoleNote") : r.permissions.length ? r.permissions.map((p) => t(`teams.perm_${p.replace(":", "_")}`)).join(", ") : t("teams.noPermissions")}
              </span>
              {!r.portal && <button onClick={() => startEdit(r)} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}>{t("teams.editRole")}</button>}
              <IconBtn label={t("teams.deleteRole")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(r.id); }}>×</IconBtn>
            </div>
          ))}
        </div>
      )}

      <div style={{ borderTop: roles.length ? "1px solid var(--c-bd)" : "none", paddingTop: roles.length ? 12 : 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{editing ? t("teams.editRole") : t("teams.addRole")}</div>
        <input style={{ ...field, width: "100%", marginBottom: 10, boxSizing: "border-box" }} placeholder={t("teams.roleName")} aria-label={t("teams.roleName")} value={name} onChange={(e) => setName(e.target.value)} />
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
