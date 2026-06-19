"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Card } from "./ui";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

/** Assign an app or database to a project environment (or unassign). */
export function EnvironmentCard({
  kind,
  id,
  environmentId,
}: {
  kind: "app" | "database";
  id: string;
  environmentId: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const move = useMutation({
    mutationFn: (envId: string | null) =>
      kind === "app" ? api.setAppEnvironment(id, envId) : api.setDatabaseEnvironment(id, envId),
    onSuccess: () => qc.invalidateQueries({ queryKey: [kind === "app" ? "app" : "database", id] }),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("projects.environment")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("projects.moveDesc")}</p>
      <select
        style={{ ...field, minWidth: 240 }}
        value={environmentId ?? ""}
        onChange={(e) => move.mutate(e.target.value || null)}
        disabled={move.isPending}
      >
        <option value="">{t("projects.unassigned")}</option>
        {projects.map((p) =>
          p.environments.map((env) => (
            <option key={env.id} value={env.id}>
              {p.name} / {env.name}
            </option>
          )),
        )}
      </select>
    </Card>
  );
}
