"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useT } from "../../../../i18n/provider";
import { useTeamScope } from "../../../../components/team-scope";
import { defaultTeamId } from "../../../../lib/team-scope";
import { BackLink, Btn, Card } from "../../../../components/ui";
import { Field, Select, TextInput } from "../../../../components/form";

export default function NewProjectPage() {
  const t = useT();
  const router = useRouter();
  const { teamId: scope } = useTeamScope();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });

  const [name, setName] = useState("");
  const [createTeam, setCreateTeam] = useState("");
  const target = createTeam || defaultTeamId(scope, teams);

  const create = useMutation({
    mutationFn: () => api.createProject(target, name),
    onSuccess: (p) => router.push(`/projects/${p.id}`),
  });

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 520 }}>
      <BackLink href="/projects" label={t("common.backTo", { target: t("nav.projects") })} />
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("projects.newTitle")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("projects.newSubtitle")}</p>

      <Card style={{ padding: 16 }}>
        <form onSubmit={(e) => { e.preventDefault(); if (name && target) create.mutate(); }}>
          <Field label={t("projects.name")} htmlFor="p-name">
            <TextInput id="p-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          {teams.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <Field label={t("common.team")}>
                <Select value={target} onChange={setCreateTeam} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
              </Field>
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <Btn type="submit" disabled={create.isPending || !name || !target}>{create.isPending ? "…" : t("projects.create")}</Btn>
          </div>
          {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
        </form>
      </Card>
    </div>
  );
}
