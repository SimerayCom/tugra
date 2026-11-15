"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import type { AppVolume, VolumeBackupPolicy } from "../../lib/types";
import { Btn } from "../ui";
import { Modal } from "../modal";
import { ScheduleField, scheduleComplete, scheduleFromFields, scheduleToFields, type ScheduleValue } from "./schedule-field";
import { RetentionFields, retentionFromFields, retentionToFields, type RetentionValue } from "./retention-fields";

const linkBtn = { background: "transparent", border: "none", color: "var(--c-a)", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 6px" } as const;

function PolicyModal({ appId, volume, policy, onClose }: { appId: string; volume: string; policy: VolumeBackupPolicy | undefined; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(policy?.enabled ?? true);
  const [custom, setCustom] = useState(!!(policy?.cron || policy?.intervalHours));
  const [schedule, setSchedule] = useState<ScheduleValue>(scheduleFromFields(policy?.intervalHours, policy?.cron));
  const [retention, setRetention] = useState<RetentionValue>({
    ...retentionFromFields(policy?.retention, policy?.retentionDays, policy?.maxSizeGb),
    keep: policy?.retention != null ? String(policy.retention) : "",
  });
  const save = useMutation({
    mutationFn: () => {
      const sch = custom ? scheduleToFields(schedule) : { intervalHours: null, cron: null };
      const r = retentionToFields(retention, { keepOptional: true });
      return api.putVolumePolicy(appId, volume, { enabled, ...sch, ...r });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["volBackupConfig", appId] }); onClose(); },
  });
  const valid = !enabled || !custom || scheduleComplete(schedule);
  return (
    <Modal onClose={onClose} width={520} ariaLabel={t("backups.volumes.editTitle", { volume })}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, maxWidth: "100%" }}>
        <div style={{ fontWeight: 700 }}>{t("backups.volumes.editTitle", { volume })}</div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("backups.enabled")}
        </label>
        {enabled && (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
              {t("backups.volumes.customSchedule")}
            </label>
            {custom && <ScheduleField value={schedule} onChange={setSchedule} minGapHours={1} />}
          </>
        )}
        <RetentionFields value={retention} onChange={setRetention} hint={t("backups.volumes.retentionInherit")} />
        {save.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>{(save.error as Error).message}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
          <Btn onClick={() => save.mutate()} disabled={save.isPending || !valid}>{t("backups.volumes.save")}</Btn>
        </div>
      </div>
    </Modal>
  );
}

/** One row per declared volume: inherits the app schedule, runs its own, or is off. Edit / reset write per-volume policies. */
export function VolumePolicyTable({ appId, volumes, policies, canWrite = true }: { appId: string; volumes: AppVolume[]; policies: VolumeBackupPolicy[]; canWrite?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: (volume: string) => api.deleteVolumePolicy(appId, volume),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["volBackupConfig", appId] }),
  });
  if (volumes.length === 0) return null;
  const stateOf = (p: VolumeBackupPolicy | undefined): string => {
    if (!p) return t("backups.volumes.inherit");
    if (!p.enabled) return t("backups.volumes.off");
    if (p.cron) return t("backups.volumes.custom", { schedule: p.cron });
    if (p.intervalHours) return t("backups.volumes.custom", { schedule: t("backups.volumes.everyHours", { hours: p.intervalHours }) });
    return t("backups.volumes.inherit");
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx2)", textTransform: "uppercase", letterSpacing: 0.4 }}>{t("backups.volumes.title")}</div>
      {volumes.map((v) => {
        const p = policies.find((x) => x.volumeName === v.name);
        return (
          <div key={v.name} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
            <span className="mono" style={{ fontSize: 12, minWidth: 90 }}>{v.name}</span>
            <span style={{ fontSize: 12, color: p && !p.enabled ? "var(--c-am)" : "var(--c-tx3)", flex: 1, minWidth: 140 }}>{stateOf(p)}</span>
            {canWrite && (
              <>
                <button type="button" style={linkBtn} onClick={() => setEditing(v.name)} aria-label={`${t("backups.volumes.edit")} ${v.name}`}>{t("backups.volumes.edit")}</button>
                {p && <button type="button" style={{ ...linkBtn, color: "var(--c-tx2)" }} disabled={reset.isPending} onClick={() => reset.mutate(v.name)} aria-label={`${t("backups.volumes.reset")} ${v.name}`}>{t("backups.volumes.reset")}</button>}
              </>
            )}
          </div>
        );
      })}
      {editing && <PolicyModal appId={appId} volume={editing} policy={policies.find((x) => x.volumeName === editing)} onClose={() => setEditing(null)} />}
    </div>
  );
}
