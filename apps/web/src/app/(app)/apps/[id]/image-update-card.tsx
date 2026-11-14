"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../../../components/toast";
import { Btn, SectionCard } from "../../../../components/ui";
import { useT } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { relativeTime } from "../../../../lib/fleet";
import { imageUpdateChip, imageUpdateErrorKey, shortDigest } from "../../../../lib/apps";
import type { Application, ImageUpdate } from "../../../../lib/types";

/** The small "Update available" chip for an app header / list row (null unless an update is known). */
export function ImageUpdateBadge({ app }: { app: { imageUpdate?: ImageUpdate | null } }) {
  const t = useT();
  const chip = imageUpdateChip(app);
  if (!chip) return null;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: "var(--r1)",
        background: "var(--c-el)",
        color: "var(--c-am)",
        border: "1px solid var(--c-bd)",
        whiteSpace: "nowrap",
      }}
    >
      {t(chip.key)}
    </span>
  );
}

const STATE_KEY: Record<Exclude<ImageUpdate["state"], "error">, string> = {
  up_to_date: "apps.iuStateUpToDate",
  update_available: "apps.iuStateAvailable",
  pending: "apps.iuStatePending",
  no_baseline: "apps.iuStateNoBaseline",
  pinned: "apps.iuStatePinned",
  disabled: "apps.iuStateDisabled",
};

const stateColor = (s: ImageUpdate["state"]): string =>
  s === "update_available" ? "var(--c-am)" : s === "up_to_date" ? "var(--c-g)" : s === "error" ? "var(--c-r)" : "var(--c-tx3)";

/** Overview card for an IMAGE app: is the upstream tag ahead of what is deployed? Anyone who can see the app sees
 *  the verdict; digests are writer-only (the hub nulls them); Check now / Pull & redeploy need the deploy right and
 *  the opt-out toggle needs the config right. */
export function ImageUpdateCard({
  app,
  canWrite,
  canDeploy,
  onRedeploy,
}: {
  app: Application;
  canWrite: boolean;
  canDeploy: boolean;
  onRedeploy: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : t("apps.iuCheckFailed"));

  const check = useMutation({
    mutationFn: () => api.checkImageUpdate(app.id),
    // Merge the fresh verdict straight into the app's cache entry (the 5 s poll would catch up anyway).
    onSuccess: (r) => qc.setQueryData<Application>(["app", app.id], (old) => (old ? { ...old, imageUpdate: r.imageUpdate } : old)),
    onError: (e) => toast(errMsg(e), "error"),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setImageUpdateCheck(app.id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", app.id] }),
    onError: (e) => toast(errMsg(e), "error"),
  });

  const iu = app.imageUpdate;
  if (!iu) return null;

  const stateLine = iu.state === "error" ? t("apps.iuStateError", { reason: t(imageUpdateErrorKey(iu.error)) }) : t(STATE_KEY[iu.state]);
  const canProbe = canDeploy && (iu.state === "pending" || iu.state === "up_to_date" || iu.state === "update_available" || iu.state === "error");
  const hint = iu.state === "error" && (iu.error === "unsupported" || iu.error === "failed") ? t(`apps.iuHint_${iu.error}`) : null;
  const showDigests = canWrite && (iu.deployedDigest || iu.upstreamDigest);

  return (
    <SectionCard title={t("apps.iuTitle")}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: stateColor(iu.state), flex: "1 1 220px", minWidth: 0 }}>{stateLine}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canProbe && (
            <Btn variant="ghost" loading={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? t("apps.iuChecking") : t("apps.iuCheckNow")}
            </Btn>
          )}
          {canDeploy && iu.state === "update_available" && <Btn onClick={onRedeploy}>{t("apps.pullRedeploy")}</Btn>}
        </div>
      </div>
      {hint && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 0" }}>{hint}</p>}
      {(iu.checkedAt || (iu.state === "update_available" && iu.changedAt)) && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--c-tx3)", display: "flex", gap: 12, flexWrap: "wrap" }}>
          {iu.checkedAt && <span>{t("apps.iuCheckedAt", { when: relativeTime(iu.checkedAt) })}</span>}
          {iu.state === "update_available" && iu.changedAt && <span>{t("apps.iuSince", { when: relativeTime(iu.changedAt) })}</span>}
        </div>
      )}
      {showDigests && (
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))", gap: 10 }}>
          {iu.deployedDigest && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 3 }}>{t("apps.iuDeployed")}</div>
              <div className="mono" style={{ fontSize: 12, color: "var(--c-tx)", wordBreak: "break-all" }}>{shortDigest(iu.deployedDigest)}</div>
            </div>
          )}
          {iu.upstreamDigest && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 3 }}>{t("apps.iuUpstream")}</div>
              <div className="mono" style={{ fontSize: 12, color: "var(--c-tx)", wordBreak: "break-all" }}>{shortDigest(iu.upstreamDigest)}</div>
            </div>
          )}
        </div>
      )}
      {canWrite && iu.state !== "pinned" && (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)" }}>
            <input type="checkbox" checked={iu.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
            {t("apps.iuToggle")}
          </label>
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px" }}>{t("apps.iuToggleHint")}</p>
        </div>
      )}
    </SectionCard>
  );
}
