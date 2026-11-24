"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { copyText } from "../../../../lib/clipboard";
import { suggestSlug, validSlug } from "../../../../lib/status-page";
import type { StatusPageManage, StatusPageSettings, Team } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { useToast } from "../../../../components/toast";
import { useConfirm } from "../../../../components/confirm";
import { Badge, Btn, Card, EmptyState, SectionCard, Spinner } from "../../../../components/ui";
import { Checkbox, Field, TextInput, Textarea } from "../../../../components/form";
import { TeamPicker } from "../../../../components/team-picker";
import { PageTitle } from "../../../../components/page-header";

export default function StatusPageSettingsPage() {
  const t = useT();
  const { data: allTeams = [], isLoading } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  // A Client of a team can't manage anything there, so only teams the user actually runs are offered.
  const teams = useMemo(() => allTeams.filter((tm) => !tm.clientAccess), [allTeams]);
  const [teamId, setTeamId] = useState("");
  useEffect(() => {
    if (!teamId && teams.length > 0) setTeamId(teams[0].id);
  }, [teamId, teams]);
  const team = teams.find((tm) => tm.id === teamId);

  const { data, isLoading: pageLoading, isError, error } = useQuery({
    queryKey: ["statusPage", teamId],
    queryFn: () => api.getStatusPage(teamId),
    enabled: !!teamId,
    retry: false,
  });

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 820 }}>
      <PageTitle title={t("statusPage.title")} subtitle={t("statusPage.subtitle")} />
      {isLoading ? (
        <Spinner />
      ) : teams.length === 0 ? (
        <Card style={{ padding: 16 }}><EmptyState>{t("statusPage.noTeam")}</EmptyState></Card>
      ) : (
        <>
          {teams.length > 1 && (
            <Field label={t("statusPage.teamLabel")} style={{ maxWidth: 320, marginBottom: 16 }}>
              <TeamPicker value={teamId} teams={teams} onChange={setTeamId} ariaLabel={t("statusPage.teamLabel")} />
            </Field>
          )}
          {pageLoading || !team ? (
            <Spinner />
          ) : isError ? (
            <p role="alert" style={{ color: "var(--c-r)", fontSize: 13 }}>{(error as Error).message}</p>
          ) : (
            // Keyed by team so switching team resets the form instead of carrying the old values over.
            <StatusPageEditor key={team.id} team={team} data={data!} />
          )}
        </>
      )}
    </div>
  );
}

function StatusPageEditor({ team, data }: { team: Team; data: StatusPageManage }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const page = data.page;
  const { data: allMonitors = [] } = useQuery({ queryKey: ["monitors"], queryFn: () => api.listMonitors() });
  const monitors = allMonitors.filter((m) => m.teamId === team.id);

  const [slug, setSlug] = useState(page?.slug ?? suggestSlug(team.name));
  const [title, setTitle] = useState(page?.title ?? team.name);
  const [description, setDescription] = useState(page?.description ?? "");
  const [enabled, setEnabled] = useState(page?.enabled ?? true);
  const [labels, setLabels] = useState<Record<string, string>>(() => Object.fromEntries((page?.monitors ?? []).map((m) => [m.monitorId, m.label ?? ""])));
  const [chosen, setChosen] = useState<string[]>(() => (page?.monitors ?? []).map((m) => m.monitorId));
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const done = (next: StatusPageManage) => {
    qc.setQueryData(["statusPage", team.id], next);
  };
  const save = useMutation({
    mutationFn: () =>
      api.saveStatusPage(team.id, {
        slug,
        title: title.trim(),
        description: description.trim() || null,
        enabled,
        monitors: chosen.map((id) => ({ monitorId: id, label: labels[id]?.trim() || null })),
      }),
    onSuccess: (next) => { done(next); toast(t("statusPage.settings.saved"), "success"); },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteStatusPage(team.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["statusPage", team.id] }); toast(t("statusPage.settings.deleted"), "success"); },
  });

  const slugOk = validSlug(slug);
  const canSave = slugOk && title.trim().length > 0 && !save.isPending;
  const origin = typeof location !== "undefined" ? location.origin : "";

  return (
    <>
      <SectionCard
        title={page ? t("statusPage.title") : t("statusPage.settings.create")}
        desc={page ? undefined : t("statusPage.settings.emptyDesc")}
        right={page ? <Badge tone={page.enabled ? "ok" : "muted"}>{t(page.enabled ? "statusPage.settings.published" : "statusPage.state.paused")}</Badge> : undefined}
      >
        <form onSubmit={(e) => { e.preventDefault(); if (canSave) save.mutate(); }} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={t("statusPage.settings.address")} hint={t("statusPage.settings.addressHint", { url: `${origin}/status/${slug || "…"}` })} error={slug && !slugOk ? t("statusPage.settings.addressInvalid") : undefined}>
            <TextInput mono value={slug} maxLength={40} autoCapitalize="none" spellCheck={false} onChange={(e) => setSlug(e.target.value.toLowerCase())} required />
          </Field>
          <Field label={t("statusPage.settings.pageTitle")}>
            <TextInput value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label={t("statusPage.settings.description")}>
            <Textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </Field>

          <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
            <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 4 }}>{t("statusPage.settings.monitors")}</legend>
            <p style={{ margin: "0 0 8px", fontSize: 11, color: "var(--c-tx3)" }}>{t("statusPage.settings.monitorsHint")}</p>
            {monitors.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("statusPage.settings.noMonitors")}</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {monitors.map((m) => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                      <Checkbox checked={chosen.includes(m.id)} onChange={() => toggle(m.id)} label={<span style={{ overflowWrap: "anywhere" }}>{m.name}</span>} />
                    </div>
                    {chosen.includes(m.id) && (
                      <TextInput
                        aria-label={`${t("statusPage.settings.labelPlaceholder")}: ${m.name}`}
                        placeholder={t("statusPage.settings.labelPlaceholder")}
                        value={labels[m.id] ?? ""}
                        maxLength={80}
                        onChange={(e) => setLabels((l) => ({ ...l, [m.id]: e.target.value }))}
                        style={{ flex: "1 1 200px", width: "auto" }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </fieldset>

          <div>
            <Checkbox checked={enabled} onChange={setEnabled} label={t("statusPage.settings.published")} />
            <span style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: 26 }}>{t("statusPage.settings.publishedHint")}</span>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn type="submit" loading={save.isPending} disabled={!canSave}>{t("statusPage.settings.save")}</Btn>
            {page && (
              <Btn
                variant="danger"
                disabled={remove.isPending}
                onClick={async () => { if (await confirm({ body: t("statusPage.settings.deleteConfirm"), danger: true })) remove.mutate(); }}
              >
                {t("statusPage.settings.delete")}
              </Btn>
            )}
          </div>
          {save.isError && <span role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{(save.error as Error).message}</span>}
        </form>
      </SectionCard>

      {page && <Links page={page} emailAvailable={data.emailAvailable} />}
      {page && <Maintenance teamId={team.id} page={page} onChanged={done} />}
    </>
  );
}

function Links({ page, emailAvailable }: { page: StatusPageSettings; emailAvailable: boolean }) {
  const t = useT();
  const toast = useToast();
  const copy = async (text: string) => { if (await copyText(text)) toast(t("statusPage.settings.copied"), "success"); };
  return (
    <SectionCard title={t("statusPage.subscribe")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a href={`/status/${page.slug}`} target="_blank" rel="noreferrer" className="tg-link" style={{ fontSize: 13, alignSelf: "center" }}>{t("statusPage.settings.open")}</a>
          <Btn variant="ghost" onClick={() => copy(page.url)}>{t("statusPage.settings.copyLink")}</Btn>
          <Btn variant="ghost" onClick={() => copy(page.rssUrl)}>{t("statusPage.settings.copyRss")}</Btn>
        </div>
        {emailAvailable ? (
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("statusPage.settings.subscribers", { confirmed: page.subscribers.confirmed, pending: page.subscribers.pending })}</span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("statusPage.settings.emailOff")}</span>
        )}
      </div>
    </SectionCard>
  );
}

/** A `datetime-local` value (local wall time) as an ISO instant. */
function toIso(local: string): string {
  return new Date(local).toISOString();
}

function Maintenance({ teamId, page, onChanged }: { teamId: string; page: StatusPageSettings; onChanged: (n: StatusPageManage) => void }) {
  const t = useT();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const add = useMutation({
    mutationFn: () => api.addStatusMaintenance(teamId, { title: title.trim(), body: body.trim() || null, startsAt: toIso(startsAt), endsAt: toIso(endsAt) }),
    onSuccess: (next) => { onChanged(next); setTitle(""); setBody(""); setStartsAt(""); setEndsAt(""); toast(t("statusPage.settings.maintAdded"), "success"); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.removeStatusMaintenance(teamId, id), onSuccess: onChanged });
  const ready = title.trim() && startsAt && endsAt && new Date(endsAt) > new Date(startsAt);
  const stateKey = { scheduled: "statusPage.maintScheduled", active: "statusPage.maintActive", completed: "statusPage.maintCompleted" } as const;

  return (
    <SectionCard title={t("statusPage.settings.maintTitle")}>
      {page.maintenance.length === 0 ? (
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--c-tx3)" }}>{t("statusPage.settings.maintNone")}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0 0 14px", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {page.maintenance.map((m) => (
            <li key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 200px", fontSize: 13 }}>
                <strong>{m.title}</strong>
                <span style={{ color: "var(--c-tx3)", marginLeft: 8, fontSize: 12 }}>{new Date(m.startsAt).toLocaleString()} – {new Date(m.endsAt).toLocaleString()}</span>
              </span>
              <Badge tone={m.state === "active" ? "warn" : "muted"}>{t(stateKey[m.state])}</Badge>
              <Btn variant="ghost" onClick={() => del.mutate(m.id)} disabled={del.isPending}>{t("statusPage.settings.maintRemove")}</Btn>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate(); }} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, alignItems: "end" }}>
        <Field label={t("statusPage.settings.maintName")}><TextInput value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <Field label={t("statusPage.settings.maintStarts")}><TextInput type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required /></Field>
        <Field label={t("statusPage.settings.maintEnds")}><TextInput type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required /></Field>
        <Field label={t("statusPage.settings.maintDetails")} style={{ gridColumn: "1 / -1" }}><Textarea rows={2} value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} /></Field>
        <div><Btn type="submit" loading={add.isPending} disabled={!ready}>{t("statusPage.settings.maintAdd")}</Btn></div>
      </form>
      {add.isError && <span role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{(add.error as Error).message}</span>}
    </SectionCard>
  );
}
