"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { SectionCard } from "./ui";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

/** Move an app or database to another project environment. */
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
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const move = useMutation({
    mutationFn: (envId: string) =>
      kind === "app" ? api.setAppEnvironment(id, envId) : api.setDatabaseEnvironment(id, envId),
    onSuccess: () => qc.invalidateQueries({ queryKey: [kind === "app" ? "app" : "database", id] }),
  });

  return (
    <SectionCard title={t("projects.assignTitle")} desc={t("projects.moveDesc")}>
      <select
        style={{ ...field, minWidth: 240 }}
        value={environmentId}
        onChange={(e) => move.mutate(e.target.value)}
        disabled={move.isPending}
      >
        {projects.map((p) =>
          p.environments.map((env) => (
            <option key={env.id} value={env.id}>
              {p.name} / {env.name}
            </option>
          )),
        )}
      </select>
    </SectionCard>
  );
}
