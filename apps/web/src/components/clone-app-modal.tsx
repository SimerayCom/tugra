"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useGuardedPush } from "../hooks/useUnsavedChanges";
import { api } from "../lib/api";
import { defaultEnvId } from "../lib/resource-new";
import { useToast } from "./toast";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { Btn } from "./ui";
import { Select, fieldStyle } from "./form";
import { ProjectPicker } from "./project-picker";

/** Machine-readable warning keys the hub's clone() can return; each has an `apps.cloneWarn_<key>` string. */
const CLONE_WARNINGS = new Set([
  "cloned_to_server",
  "cluster_config_reset",
  "host_mounts_copied",
  "domain_reset",
  "custom_cert_dropped",
  "host_port_reset",
  "port_mappings_copied",
  "tasks_disabled",
  "cpuset_reset",
  "privileged_options_dropped",
  "custom_labels_dropped",
  "gpus_unavailable_on_target",
]);

/**
 * Clone an app into a new one. The name, the TARGET ENVIRONMENT (same team only, defaulting to the source's
 * own) and the TARGET SERVER are operator-settable;
 * the domain, TLS cert, webhook and host ports are reset server-side and volumes start empty. Cloning to a
 * different server also resets the cluster/placement topology — the dialog says so.
 */
export function CloneAppModal({
  appId,
  defaultName,
  teamId,
  currentServerId,
  currentEnvironmentId,
  onClose,
}: {
  appId: string;
  defaultName: string;
  teamId: string;
  currentServerId: string;
  currentEnvironmentId: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const push = useGuardedPush();
  const [name, setName] = useState(defaultName);
  const [serverId, setServerId] = useState(currentServerId);
  const { data: servers } = useQuery({ queryKey: ["servers", teamId], queryFn: () => api.listServers({ teamId }) });
  // The hub refuses an environment from another team, so only this team's projects are offered.
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const qc = useQueryClient();
  const pool = (projects ?? []).filter((p) => p.teamId === teamId);
  const currentProject = currentEnvironmentId ? pool.find((p) => p.environments.some((e) => e.id === currentEnvironmentId)) : undefined;
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const [pickedEnv, setPickedEnv] = useState<string | null>(null);
  // Starts on where the source lives; "" is "same as the source" (the source's environment is not listed).
  const projectId = pickedProject ?? currentProject?.id ?? "";
  const chosen = pool.find((p) => p.id === projectId);
  const environmentId = pickedEnv ?? (chosen && chosen.id === currentProject?.id ? currentEnvironmentId ?? "" : "");
  const chooseProject = (name: string) => {
    const hit = pool.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (name === "") {
      setPickedProject("");
      setPickedEnv("");
    } else if (hit) {
      setPickedProject(hit.id);
      setPickedEnv(defaultEnvId(hit));
    } // else: a project just created from the picker; createProject() already selected it.
  };
  const createProject = async (name: string) => {
    const created = await api.createProject(teamId, name);
    await qc.refetchQueries({ queryKey: ["projects"] });
    setPickedProject(created.id);
    setPickedEnv(defaultEnvId(created));
  };
  const envChoices = (chosen?.environments ?? []).map((e) => ({
    value: e.id,
    label: e.id === currentEnvironmentId ? `${e.name} ${t("apps.cloneEnvironmentCurrent")}` : e.name,
  }));
  const clone = useMutation({
    mutationFn: () =>
      api.cloneApp(appId, {
        name: name.trim() || undefined,
        serverId,
        // Only sent when it differs from the source's own, so the default request is unchanged.
        ...(environmentId && environmentId !== currentEnvironmentId ? { environmentId } : {}),
      }),
    onSuccess: (res) => {
      const known = res.warnings.filter((w) => CLONE_WARNINGS.has(w));
      const other = res.warnings.length - known.length;
      const notes = [...known.map((w) => t(`apps.cloneWarn_${w}`)), ...(other > 0 ? [t("apps.cloneWarn_other")] : [])];
      if (notes.length > 0) toast(notes.join(" "), "info");
      onClose();
      push(`/apps/${res.app.id}`);
    },
  });
  const options = (servers ?? []).map((s) => ({
    value: s.id,
    label: s.id === currentServerId ? `${s.name} ${t("apps.cloneServerCurrent")}` : s.name,
  }));

  return (
    <Modal onClose={onClose} width={440} ariaLabel={t("apps.cloneTitle")}>
      <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>{t("apps.cloneTitle")}</h3>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.cloneHint")}</p>
      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("apps.cloneName")}</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !clone.isPending) clone.mutate(); }}
          aria-label={t("apps.cloneName")}
          style={{ ...fieldStyle, width: "100%" }}
        />
      </label>
      <div style={{ marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("apps.cloneProject")}</span>
        <ProjectPicker
          value={chosen?.name ?? ""}
          projects={pool.map((p) => ({ name: p.name }))}
          onChange={chooseProject}
          onCreate={createProject}
          noneLabel={t("apps.cloneEnvironmentPlaceholder")}
          ariaLabel={t("apps.cloneProject")}
        />
      </div>
      {chosen && (
        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("apps.cloneEnvironment")}</span>
          <Select value={environmentId} onChange={setPickedEnv} options={envChoices} ariaLabel={t("apps.cloneEnvironment")} />
        </label>
      )}
      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("apps.cloneServer")}</span>
        <Select value={serverId} onChange={setServerId} options={options} ariaLabel={t("apps.cloneServer")} />
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={clone.isPending}>{t("common.cancel")}</Btn>
        <Btn onClick={() => clone.mutate()} disabled={clone.isPending || !name.trim()}>{clone.isPending ? "…" : t("apps.clone")}</Btn>
      </div>
      {clone.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(clone.error as Error).message}</div>}
    </Modal>
  );
}
