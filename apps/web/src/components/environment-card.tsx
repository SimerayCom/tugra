"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { defaultEnvId } from "../lib/resource-new";
import { Btn, SectionCard } from "./ui";
import { Select } from "./form";
import { ProjectPicker } from "./project-picker";
import { useToast } from "./toast";

/**
 * Move an app or database to another project environment. A resource stays in its team, so only that team's projects
 * are offered, through the shared project picker (with "+ New project"), then one of the project's environments.
 */
export function EnvironmentCard({
  kind,
  id,
  environmentId,
}: {
  kind: "app" | "database";
  id: string;
  environmentId: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const current = projects.find((p) => p.environments.some((e) => e.id === environmentId));
  const pool = current ? projects.filter((p) => p.teamId === current.teamId) : projects;

  const [projectId, setProjectId] = useState("");
  const [envId, setEnvId] = useState("");
  // Start on where the resource is now; follow it after a move.
  useEffect(() => {
    if (current) {
      setProjectId(current.id);
      setEnvId(environmentId);
    }
  }, [current?.id, environmentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = pool.find((p) => p.id === projectId);

  const move = useMutation({
    mutationFn: (target: string) =>
      kind === "app" ? api.setAppEnvironment(id, target) : api.setDatabaseEnvironment(id, target),
    onSuccess: (_r, target) => {
      void qc.invalidateQueries({ queryKey: [kind === "app" ? "app" : "database", id] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      const label = projects.flatMap((p) => p.environments.map((env) => ({ id: env.id, label: `${p.name} / ${env.name}` }))).find((e) => e.id === target)?.label;
      toast(t("projects.moved", { name: label ?? "" }), "success");
    },
  });

  const choose = (name: string) => {
    const hit = pool.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!hit) return;
    setProjectId(hit.id);
    setEnvId(hit.environments.some((e) => e.id === environmentId) ? environmentId : defaultEnvId(hit));
  };
  const create = async (name: string) => {
    if (!current) throw new Error(t("pickers.project.failed"));
    const created = await api.createProject(current.teamId, name);
    await qc.refetchQueries({ queryKey: ["projects"] });
    setProjectId(created.id);
    setEnvId(defaultEnvId(created));
  };

  return (
    <SectionCard title={t("projects.assignTitle")} desc={t("projects.moveDesc")}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <ProjectPicker
            value={chosen?.name ?? ""}
            projects={pool.map((p) => ({ name: p.name }))}
            onChange={choose}
            onCreate={create}
            disabled={move.isPending}
            ariaLabel={t("resources.chooseProject")}
          />
        </div>
        {chosen && (
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <Select
              value={envId}
              onChange={setEnvId}
              ariaLabel={t("resources.environment")}
              disabled={move.isPending}
              options={chosen.environments.map((e) => ({ value: e.id, label: e.name }))}
              style={{ minHeight: 44, fontSize: 14 }}
            />
          </div>
        )}
        <Btn onClick={() => move.mutate(envId)} disabled={!envId || envId === environmentId} loading={move.isPending} style={{ minHeight: 44 }}>
          {t("projects.moveConfirm")}
        </Btn>
      </div>
      {move.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(move.error as Error).message}</div>}
    </SectionCard>
  );
}
