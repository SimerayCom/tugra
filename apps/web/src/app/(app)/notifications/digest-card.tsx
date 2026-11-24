"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Btn, Card } from "../../../components/ui";
import { Checkbox, Field, Select } from "../../../components/form";
import type { Channel } from "../../../lib/types";

/**
 * The weekly digest for one team: opt-in, one chosen channel, Monday morning in the hub's time zone.
 * Anyone in the team can see it; only people who can manage channels can change it.
 */
export function DigestCard({ teamId, channels, canWrite }: { teamId: string; channels: Channel[]; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["teamDigest", teamId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.getTeamDigest(teamId), enabled: !!teamId });
  const mine = channels.filter((c) => c.teamId === teamId);

  const save = useMutation({
    mutationFn: (v: { enabled: boolean; channelId?: string | null }) => api.updateTeamDigest(teamId, v),
    onSuccess: (d) => qc.setQueryData(key, d),
  });
  const send = useMutation({
    mutationFn: () => api.sendTeamDigest(teamId),
    onSuccess: () => toast(t("notifications.digestSent"), "success"),
  });

  // Nothing to show until the setting loads (and nothing to offer a team with no channel to send it to).
  if (!data) return null;
  const when = t("notifications.digestWhen", { hour: String(data.hour).padStart(2, "0"), zone: data.timezone });
  const err = (save.error ?? send.error) as Error | null;

  return (
    <Card style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <CalendarClock size={16} color="var(--c-a)" aria-hidden />
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{t("notifications.digestTitle")}</h2>
      </div>
      <p style={{ color: "var(--c-tx3)", fontSize: 13, margin: "0 0 12px" }}>{t("notifications.digestBody")}</p>

      {mine.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: 0 }}>{t("notifications.digestNoChannel")}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Checkbox
            id={`digest-on-${teamId}`}
            checked={data.enabled}
            disabled={!canWrite || save.isPending}
            onChange={(enabled) => save.mutate({ enabled, channelId: data.channelId ?? mine[0]?.id })}
            label={t("notifications.digestOn")}
          />
          <Field label={t("notifications.digestChannel")} htmlFor={`digest-ch-${teamId}`} hint={data.enabled ? when : t("notifications.digestOffHint")} style={{ maxWidth: 360 }}>
            <Select
              id={`digest-ch-${teamId}`}
              value={data.channelId ?? ""}
              disabled={!canWrite || save.isPending}
              onChange={(channelId) => save.mutate({ enabled: data.enabled, channelId })}
              options={mine.map((c) => ({ value: c.id, label: c.name }))}
              placeholder={t("notifications.digestPick")}
            />
          </Field>
          {canWrite && (
            <div>
              <Btn variant="ghost" onClick={() => send.mutate()} loading={send.isPending} disabled={!data.channelId || send.isPending}>
                {t("notifications.digestSendNow")}
              </Btn>
            </div>
          )}
        </div>
      )}
      {err && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{err.message}</div>}
    </Card>
  );
}
