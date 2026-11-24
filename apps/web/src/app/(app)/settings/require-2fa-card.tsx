"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Card } from "../../../components/ui";
import { Checkbox } from "../../../components/form";
import { useToast } from "../../../components/toast";

/**
 * Owner-only instance policy: require two-factor authentication for owners and admins. The hub refuses to switch
 * it on for an owner who has no 2FA yet (so the policy can never strand its own author); this card mirrors that by
 * disabling the switch with the reason beside it. Returns null for non-owners (the hub enforces the same).
 */
export function Require2faCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const { data } = useQuery({
    queryKey: ["instanceSettings"],
    queryFn: () => api.getInstanceSettings(),
    enabled: isOwner,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (require2fa: boolean) => api.updateInstanceSettings({ require2fa }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instanceSettings"] });
      toast(t("settings.require2faSaved"), "success");
    },
  });
  if (!isOwner) return null;
  const on = !!data?.require2fa;
  const blocked = !on && !user?.twoFaEnabled;
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("settings.require2fa")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("settings.require2faDesc")}</p>
      <Checkbox
        checked={on}
        disabled={!data || save.isPending || blocked}
        onChange={(v) => save.mutate(v)}
        label={t("settings.require2faSwitch")}
      />
      {blocked && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("settings.require2faNeedsOwn")}</div>}
    </Card>
  );
}
