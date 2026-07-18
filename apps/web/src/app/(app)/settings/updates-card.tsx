"use client";

import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card } from "../../../components/ui";
import { Field, Select } from "../../../components/form";
import { useUpdateStream, type UpdatePhase } from "../../../hooks/useUpdateStream";

const WORKING: UpdatePhase[] = ["starting", "queued", "pulling", "recreating"];
function phaseLabel(phase: UpdatePhase): string {
  if (phase === "pulling") return "settings.updatePulling";
  if (phase === "recreating") return "settings.updateWaiting";
  return "settings.updateStarting";
}

/**
 * Owner-only self-update panel: shows the running vs latest version, lets the owner pick a release
 * channel + toggle auto-update, and re-check on demand. Rendered for every settings visitor but returns
 * null unless the user owns the instance (the hub enforces the same guard). The one-click "Update now"
 * arrives with the updater slice; for now an available update is applied by re-running the installer.
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

  const [channel, setChannel] = useState("stable");
  const [autoUpdate, setAutoUpdate] = useState(false);
  // Seed the form ONCE from the first load. A "Check for updates" invalidates + refetches this query, so
  // re-seeding on every `data` change would silently discard the owner's unsaved channel/toggle edits.
  // The displayed status (current/latest/badge) reads from `data` directly, so it still refreshes live.
  const seeded = useRef(false);
  useEffect(() => {
    if (data && !seeded.current) {
      seeded.current = true;
      setChannel(data.channel);
      setAutoUpdate(data.autoUpdate);
    }
  }, [data]);

  const check = useMutation({
    mutationFn: () => api.checkInstanceUpdate(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instanceUpdate"] }),
  });

  const save = useMutation({
    mutationFn: () => api.updateInstanceUpdate({ autoUpdate, updateChannel: channel }),
    onSuccess: (res) => {
      setChannel(res.channel);
      setAutoUpdate(res.autoUpdate);
      qc.invalidateQueries({ queryKey: ["instanceUpdate"] });
      // A changed channel means the cached "latest" is for the old channel — refresh it.
      if (data && res.channel !== data.channel) check.mutate();
    },
  });

  const upd = useUpdateStream();
  const working = WORKING.includes(upd.phase);

  if (!isOwner) return null;

  return (
    <Card style={{ padding: 18, marginTop: 16 }}>
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

      {(data?.updateAvailable || working || upd.phase === "done" || upd.phase === "failed" || upd.messageKey) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "0 0 14px" }}>
          {working ? (
            <span style={{ fontSize: 13, color: "var(--c-tx2)" }}>{t(phaseLabel(upd.phase))}</span>
          ) : upd.phase === "done" ? (
            <span style={{ fontSize: 13, color: "var(--c-ok, var(--c-tx2))" }}>{t("settings.updatedTo", { version: upd.target ?? "" })}</span>
          ) : (
            data?.updateAvailable && <Btn onClick={() => upd.start()}>{t("settings.updateNow")}</Btn>
          )}
          {upd.messageKey && !working && upd.phase !== "done" && (
            <span style={{ fontSize: 12, color: upd.phase === "failed" ? "var(--c-r)" : "var(--c-tx3)" }}>{t(upd.messageKey)}</span>
          )}
        </div>
      )}

      <Field label={t("settings.updateChannel")} htmlFor="upd-channel">
        <Select
          id="upd-channel"
          value={channel}
          onChange={setChannel}
          options={[
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
        </span>
      </label>

      {save.isError && (
        <div style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 8 }}>
          {save.error instanceof Error ? save.error.message : t("settings.updateSaveFailed")}
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("settings.updateSave")}</Btn>
        <Btn variant="ghost" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? t("settings.updateChecking") : t("settings.updateCheck")}
        </Btn>
      </div>
    </Card>
  );
}
