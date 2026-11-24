"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Btn } from "../../../components/ui";
import { Checkbox, Field, NumberInput, Select, TextInput } from "../../../components/form";
import { draftFromPolicy, policyFromDraft, REPEAT_WINDOWS, MAX_RATE_PER_MIN, type PolicyDraft } from "../../../lib/notification-policy";
import type { Channel } from "../../../lib/types";

/** Time zones the browser knows, for the datalist (empty where unsupported: the field is still free text). */
function zoneNames(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/**
 * Delivery rules for a saved channel: quiet hours, a per-minute limit and how repeats are folded.
 * Held alerts are never lost: they arrive as one short summary when the quiet hours end, the repeat window
 * closes or the limit resets.
 */
export function ChannelPolicyPanel({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFromPolicy(channel.policy));
  const [error, setError] = useState("");
  const set = (patch: Partial<PolicyDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const id = `policy-${channel.id}`;
  const zones = zoneNames();

  const save = useMutation({
    mutationFn: () => {
      const { body, problems } = policyFromDraft(draft);
      if (problems.length) throw new Error(problems.map((p) => t(`notifications.policyProblem_${p}`, { max: MAX_RATE_PER_MIN })).join(" "));
      return api.updateChannel(channel.id, { policy: body });
    },
    onSuccess: () => {
      setError("");
      qc.invalidateQueries({ queryKey: ["channels"] });
      toast(t("notifications.policySaved"), "success");
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div style={{ width: "100%", borderTop: "1px solid var(--c-bd)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 14 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("notifications.policyIntro")}</p>

      <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", padding: 0, marginBottom: 6 }}>{t("notifications.quietTitle")}</legend>
        <Checkbox id={`${id}-quiet`} checked={draft.quietOn} onChange={(v) => set({ quietOn: v })} label={t("notifications.quietOn")} />
        {draft.quietOn && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
              <Field label={t("notifications.quietFrom")} htmlFor={`${id}-from`}>
                <TextInput id={`${id}-from`} type="time" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
              </Field>
              <Field label={t("notifications.quietTo")} htmlFor={`${id}-to`}>
                <TextInput id={`${id}-to`} type="time" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
              </Field>
              <Field label={t("notifications.quietZone")} htmlFor={`${id}-tz`}>
                <TextInput id={`${id}-tz`} list={`${id}-zones`} value={draft.tz} onChange={(e) => set({ tz: e.target.value })} autoComplete="off" spellCheck={false} />
                <datalist id={`${id}-zones`}>
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </Field>
            </div>
            <Checkbox id={`${id}-crit`} checked={draft.allowCritical} onChange={(v) => set({ allowCritical: v })} label={t("notifications.quietCritical")} />
          </>
        )}
      </fieldset>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <Field label={t("notifications.rateLabel")} htmlFor={`${id}-rate`} hint={t("notifications.rateHint")}>
          <NumberInput id={`${id}-rate`} min={1} max={MAX_RATE_PER_MIN} value={draft.rate} onChange={(e) => set({ rate: e.target.value })} />
        </Field>
        <Field label={t("notifications.repeatLabel")} htmlFor={`${id}-repeat`} hint={t("notifications.repeatHint")}>
          <Select
            id={`${id}-repeat`}
            value={draft.window}
            onChange={(v) => set({ window: v })}
            options={REPEAT_WINDOWS.map((w) => ({ value: w, label: t(`notifications.repeat_${w === "" ? "default" : w}`) }))}
            placeholder={t("notifications.repeat_default")}
          />
        </Field>
      </div>

      {error && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={() => save.mutate()} loading={save.isPending}>{t("common.save")}</Btn>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
      </div>
    </div>
  );
}
