"use client";

import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card } from "../../../components/ui";
import { Field, Select, useSaveFeedback } from "../../../components/form";
import { useToast } from "../../../components/toast";
import { relativeTime } from "../../../lib/fleet";
import {
  formatElapsed,
  updateSteps,
  useUpdateStream,
  type UpdatePhase,
  type UpdateStepId,
  type UpdateStepState,
} from "../../../hooks/useUpdateStream";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";

const WORKING: UpdatePhase[] = ["starting", "queued", "pulling", "recreating", "reconnecting"];

const STEP_LABEL: Record<UpdateStepId, string> = {
  queued: "settings.updateStepQueued",
  pulling: "settings.updateStepPulling",
  recreating: "settings.updateStepRecreating",
  reconnecting: "settings.updateStepReconnecting",
};
const STEP_STATE_LABEL: Record<UpdateStepState, string> = {
  pending: "settings.updateStepPending",
  active: "settings.updateStepActive",
  done: "settings.updateStepDone",
  failed: "settings.updateStepFailed",
};

/** Ticks once a second while `running`; freezes at `endedAt` once the run finishes. */
function useElapsed(startedAt: number | null, endedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null || endedAt != null) return;
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [startedAt, endedAt]);
  if (startedAt == null) return 0;
  return (endedAt ?? now) - startedAt;
}

function StepMark({ state, label }: { state: UpdateStepState; label: string }) {
  const common = { size: 18, "aria-hidden": true as const, style: { flexShrink: 0 } };
  return (
    <span role="img" aria-label={label} style={{ display: "inline-flex" }}>
      {state === "done" ? (
        <CheckCircle2 {...common} style={{ ...common.style, color: "var(--c-g)" }} />
      ) : state === "failed" ? (
        <XCircle {...common} style={{ ...common.style, color: "var(--c-r)" }} />
      ) : state === "active" ? (
        <Loader2 {...common} className="tg-upd-spin" style={{ ...common.style, color: "var(--c-a)" }} />
      ) : (
        <Circle {...common} style={{ ...common.style, color: "var(--c-tx3)" }} />
      )}
    </span>
  );
}

/**
 * The visible "Update now" run: a 4-step stepper (Queued → Pulling → Recreating → Reconnecting), an
 * indeterminate bar while working, elapsed time and the target version. Steps wrap/stack on narrow widths.
 */
function UpdateProgress({ upd }: { upd: ReturnType<typeof useUpdateStream> }) {
  const t = useT();
  const working = WORKING.includes(upd.phase);
  const failed = upd.phase === "failed" || upd.phase === "recovery_required";
  const elapsed = useElapsed(upd.startedAt, upd.endedAt);
  const steps = updateSteps(upd.phase, upd.failedStep);
  // The hub is recreated during step 3, dropping the stream: say so rather than look frozen.
  const hubRestarting = working && (upd.phase === "recreating" || upd.phase === "reconnecting");
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-progress"
      style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, margin: "0 0 14px", display: "flex", flexDirection: "column", gap: 10 }}
    >
      <style>{`
        @keyframes tg-upd-slide { 0% { left: -40%; } 100% { left: 100%; } }
        .tg-upd-spin { animation: spin 0.9s linear infinite; }
        .tg-upd-bar > span { animation: tg-upd-slide 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .tg-upd-spin, .tg-upd-bar > span { animation-duration: 4s; } }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--c-tx2)" }}>
        <span>{upd.target ? t("settings.updateTarget", { version: upd.target }) : t("settings.updateStarting")}</span>
        <span data-testid="update-elapsed">{t("settings.updateElapsed", { time: formatElapsed(elapsed) })}</span>
      </div>
      {working && (
        <div className="tg-upd-bar" aria-hidden style={{ position: "relative", height: 4, borderRadius: 2, background: "var(--c-bd)", overflow: "hidden" }}>
          <span style={{ position: "absolute", top: 0, bottom: 0, width: "40%", borderRadius: 2, background: "var(--c-a)" }} />
        </div>
      )}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
        {steps.map((s) => (
          <li key={s.id} data-step={s.id} data-state={s.state} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
            <StepMark state={s.state} label={t(STEP_STATE_LABEL[s.state])} />
            <span style={{ minWidth: 0 }}>
              <span style={{ color: s.state === "failed" ? "var(--c-r)" : s.state === "pending" ? "var(--c-tx3)" : "var(--c-tx)", fontWeight: s.state === "active" ? 600 : 400 }}>
                {t(STEP_LABEL[s.id])}
              </span>
              {s.id === "recreating" && s.state === "active" && hubRestarting && (
                <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.updateHubRestarting")}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {upd.phase === "done" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--c-g)" }}>{t("settings.updatedTo", { version: upd.target ?? "" })}</span>
          <Btn onClick={() => window.location.reload()}>{t("settings.updateReload")}</Btn>
          <span style={{ fontSize: 12, color: "var(--c-tx3)", flexBasis: "100%" }}>{t("settings.updateReloadHint")}</span>
        </div>
      )}
      {failed && upd.messageKey && (
        <span style={{ fontSize: 12, color: "var(--c-r)" }}>{t(upd.messageKey)}</span>
      )}
    </div>
  );
}

/**
 * Owner-only self-update panel: shows the running vs latest version, lets the owner pick a release
 * channel + toggle auto-update, and re-check on demand. Rendered for every settings visitor but returns
 * null unless the user owns the instance (the hub enforces the same guard). When an update is available, "Update now"
 * applies it in one click.
 */
export function UpdatesCard() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  const { data } = useQuery({
    queryKey: ["instanceUpdate"],
    queryFn: () => api.getInstanceUpdate(),
    enabled: isOwner,
    // Editable form seeded from `data`; a focus refetch mid-edit would clobber the selects.
    refetchOnWindowFocus: false,
  });

  const [channel, setChannel] = useState("auto");
  const [autoUpdate, setAutoUpdate] = useState(false);
  // Seed the form ONCE from the first load. A "Check for updates" invalidates + refetches this query, so
  // re-seeding on every `data` change would silently discard the owner's unsaved channel/toggle edits.
  // The displayed status (current/latest/badge) reads from `data` directly, so it still refreshes live.
  const seeded = useRef(false);
  useEffect(() => {
    if (data && !seeded.current) {
      seeded.current = true;
      setChannel(data.channelSource === "auto" ? "auto" : data.channel);
      setAutoUpdate(data.autoUpdate);
    }
  }, [data]);

  const toast = useToast();
  const saveFeedback = useSaveFeedback("settings.updateSaved");

  // `silent` = triggered internally (channel changed on save) — the owner didn't ask, so no result toast.
  const check = useMutation({
    mutationFn: (_silent: boolean) => api.checkInstanceUpdate(),
    onSuccess: (res, silent) => {
      qc.invalidateQueries({ queryKey: ["instanceUpdate"] });
      if (silent) return;
      // Never leave an unchanged badge silent: always say what the check found.
      if (res.lastCheckError) toast(t("settings.updateCheckFailedToast", { reason: res.lastCheckError }), "error");
      else if (res.updateAvailable && res.latest) toast(t("settings.updateCheckAvailableToast", { version: res.latest }), "info");
      else toast(t("settings.updateCheckUpToDateToast", { version: res.current }), "success");
    },
  });

  const save = useMutation({
    ...saveFeedback,
    mutationFn: () => api.updateInstanceUpdate({ autoUpdate, updateChannel: channel === "auto" ? null : channel === "beta" ? "beta" : "stable" }),
    onSuccess: (res) => {
      setChannel(res.channelSource === "auto" ? "auto" : res.channel);
      setAutoUpdate(res.autoUpdate);
      qc.invalidateQueries({ queryKey: ["instanceUpdate"] });
      // A changed channel means the cached "latest" is for the old channel — refresh it.
      if (data && res.channel !== data.channel) check.mutate(true);
    },
  });

  const upd = useUpdateStream();
  const working = WORKING.includes(upd.phase);
  // The page keeps running the OLD web bundle after the hub updates — celebrate, and the card offers a Reload.
  const phase = upd.phase;
  const target = upd.target;
  useEffect(() => {
    if (phase === "done") toast(t("settings.updatedTo", { version: target ?? "" }), "success");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (!isOwner) return null;

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("settings.updates")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("settings.updatesDesc")}</p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <span style={{ fontSize: 13 }}>
          <span style={{ color: "var(--c-tx3)" }}>{t("settings.updateCurrent")}: </span>
          <code>{data?.current ?? "…"}</code>
        </span>
        {data?.updateAvailable ? (
          <Badge tone="gold">{t("settings.updateAvailable")} — {data.latest}</Badge>
        ) : (
          <Badge tone="muted">{data?.latest ? t("settings.updateUpToDate") : t("settings.updateUnknown")}</Badge>
        )}
        {data?.changelogUrl && (
          <a href={data.changelogUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "var(--c-a)" }}>
            {t("settings.updateViewChangelog")}
          </a>
        )}
      </div>

      {data && (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "-6px 0 14px", overflowWrap: "anywhere" }}>
          {data.checksEnabled === false ? (
            t("settings.updateChecksDisabled")
          ) : (
            <>
              {data.lastCheckedAt ? t("settings.updateLastChecked", { when: relativeTime(data.lastCheckedAt) }) : t("settings.updateUnknown")}
              {data.lastCheckError && (
                <span style={{ color: "var(--c-r)" }}> · {t("settings.updateLastCheckFailed", { reason: data.lastCheckError })}</span>
              )}
            </>
          )}
        </p>
      )}

      {/* Run in progress / finished: the stepper. The button below is hidden for the whole run (no double-fire). */}
      {(working || upd.phase === "done" || upd.phase === "failed" || upd.phase === "recovery_required") && <UpdateProgress upd={upd} />}

      {!working && upd.phase !== "done" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "0 0 14px" }}>
          {/* Don't invite another update when the stack needs manual recovery. */}
          {data?.updateAvailable && upd.phase !== "recovery_required" && <Btn onClick={() => upd.start()}>{t("settings.updateNow")}</Btn>}
          {/* Non-started outcomes (already up to date, notify-only, in progress…); failures render inside the stepper. */}
          {upd.messageKey && upd.phase !== "failed" && upd.phase !== "recovery_required" && (
            <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t(upd.messageKey)}</span>
          )}
        </div>
      )}

      <Field label={t("settings.updateChannel")} htmlFor="upd-channel" hint={t("settings.channelAutoHint")}>
        <Select
          id="upd-channel"
          value={channel}
          onChange={setChannel}
          options={[
            {
              value: "auto",
              label: t("settings.channelAuto", {
                channel: t(data?.channel === "beta" ? "settings.channelBeta" : "settings.channelStable"),
              }),
            },
            { value: "stable", label: t("settings.channelStable") },
            { value: "beta", label: t("settings.channelBeta") },
          ]}
        />
      </Field>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", fontSize: 13, margin: "14px 0" }}>
        <input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} style={{ marginTop: 2, accentColor: "var(--c-a)" }} />
        <span>
          <span style={{ fontWeight: 600 }}>{t("settings.updateAuto")}</span>
          <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{t("settings.updateAutoHint")}</span>
          {data && <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", marginTop: 2 }}>{t("settings.updateChecksEvery", { minutes: data.checkIntervalMin })}</span>}
        </span>
      </label>

      {save.isError && (
        <div style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 8 }}>
          {save.error instanceof Error ? save.error.message : t("settings.updateSaveFailed")}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("settings.updateSave")}</Btn>
        <Btn
          variant="ghost"
          onClick={() => check.mutate(false)}
          disabled={check.isPending || data?.checksEnabled === false}
          title={data?.checksEnabled === false ? t("settings.updateChecksDisabled") : undefined}
        >
          {check.isPending ? t("settings.updateChecking") : t("settings.updateCheck")}
        </Btn>
      </div>
    </Card>
  );
}
