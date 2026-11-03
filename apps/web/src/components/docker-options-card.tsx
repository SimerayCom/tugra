"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../i18n/provider";
import { ConfigCard, Checkbox, Field, TextInput, useSaveFeedback } from "./form";
import { useConfirm } from "./confirm";

/**
 * Raw docker-run flags for an app. The flags field was placeholder-only (no accessible name) and
 * its Save never gated on change; it now has a labelled Field and a dirty-gated Save. The
 * owner-only "allow privileged" toggle stays a confirm-gated switch above the editor.
 */
export function DockerOptionsCard({ id, dockerOptions, allowPrivileged }: { id: string; dockerOptions: string | null; allowPrivileged: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const feedback = useSaveFeedback("apps.saved");
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const confirm = useConfirm();
  const [val, setVal] = useState(dockerOptions ?? "");
  // Keep the field in sync when the server changes the stored value out from under it — e.g. disabling
  // the privileged override clears privileged options server-side, so stale text must not linger.
  useEffect(() => setVal(dockerOptions ?? ""), [dockerOptions]);

  const save = useMutation({
    mutationFn: () => api.setAppDockerOptions(id, val.trim() || null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    ...feedback,
  });
  // Host-privilege gate — INSTANCE OWNER only (the hub re-checks session + owner; this is a render gate).
  const togglePriv = useMutation({
    mutationFn: (allow: boolean) => api.setAppAllowPrivilegedDockerOptions(id, allow),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    ...feedback,
  });
  const onTogglePriv = async (next: boolean) => {
    if (next && !(await confirm({ title: t("apps.privilegedConfirmTitle"), body: t("apps.privilegedConfirmBody"), danger: true }))) return;
    togglePriv.mutate(next);
  };

  return (
    <ConfigCard title={t("apps.dockerOptions")} desc={t("apps.dockerOptionsDesc")} dirty={val !== (dockerOptions ?? "")} saving={save.isPending} onSave={() => save.mutate()}>
      {isOwner && (
        <div style={{ marginBottom: 10 }}>
          <Checkbox checked={allowPrivileged} disabled={togglePriv.isPending} onChange={onTogglePriv} label={t("apps.privilegedToggle")} />
        </div>
      )}
      {allowPrivileged && <p role="alert" style={{ fontSize: 12, color: "var(--c-r)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.privilegedHint")}</p>}
      <Field label={t("apps.dockerOptionsLabel")}>
        <TextInput mono value={val} placeholder={t("apps.dockerOptionsPlaceholder")} onChange={(e) => setVal(e.target.value)} spellCheck={false} autoComplete="off" />
      </Field>
    </ConfigCard>
  );
}
