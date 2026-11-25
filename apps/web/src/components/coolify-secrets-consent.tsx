"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COOLIFY_SECRETS_GRANT_DEFAULT_HOURS, COOLIFY_SECRETS_GRANT_MAX_HOURS, COOLIFY_SECRET_CLASSES, COOLIFY_SECRET_TIER, type CoolifySecretClass } from "@tugra/shared";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { formatDateTime } from "../lib/format-time";
import { Badge, Btn } from "./ui";
import { Checkbox, Field, NumberInput, TextInput } from "./form";

type T = ReturnType<typeof useT>;

/** One localized line for a failed call: the hub's stable code when the web knows it, else a generic one. Never the response text. */
export function consentErrorText(t: T, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return t("coolifyMove.consent.error.forbidden");
    if (e.code) {
      const k = `coolifyMove.consent.error.${e.code}`;
      if (t(k) !== k) return t(k);
    }
    if (e.status === 400) return t("coolifyMove.consent.error.name");
  }
  return t("coolifyMove.consent.error.generic");
}

/** The classes ticked when the form opens: tier 1 on, tier 2 off (the owner opts in to those). */
export const defaultClasses = (): CoolifySecretClass[] => COOLIFY_SECRET_CLASSES.filter((c) => COOLIFY_SECRET_TIER[c] === "T1");

/**
 * Consent to read Coolify's secret values on one Coolify host (owner only; the hub enforces it). Allowing needs the host's name typed.
 * Nothing on this screen ever holds a secret: it shows the consent (classes, window, status) and nothing else.
 */
export function CoolifySecretsConsent({ teamId, serverId, serverName, isOwner }: { teamId: string; serverId: string; serverName: string; isOwner: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [classes, setClasses] = useState<CoolifySecretClass[]>(defaultClasses);
  const [hours, setHours] = useState(String(COOLIFY_SECRETS_GRANT_DEFAULT_HOURS));
  const [typed, setTyped] = useState("");
  const key = ["coolify-secrets-grants", teamId];
  const grants = useQuery({ queryKey: key, queryFn: () => api.coolifySecretsGrants(teamId) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["coolify-move", teamId] });
  };
  const allow = useMutation({
    mutationFn: () => api.coolifySecretsGrant({ serverId, confirm: typed.trim(), classes, hours: Math.min(COOLIFY_SECRETS_GRANT_MAX_HOURS, Math.max(1, Math.floor(Number(hours) || COOLIFY_SECRETS_GRANT_DEFAULT_HOURS))) }),
    onSuccess: () => {
      setTyped("");
      refresh();
    },
  });
  const stop = useMutation({ mutationFn: (id: string) => api.coolifySecretsRevoke(id), onSuccess: refresh });

  const now = Date.now();
  const active = (grants.data ?? []).find((g) => g.serverId === serverId && g.kind === "secrets" && g.status === "active" && Date.parse(g.expiresAt) > now);
  const err = allow.error ?? stop.error;
  const toggle = (c: CoolifySecretClass, on: boolean) => setClasses((cur) => (on ? [...cur, c] : cur.filter((x) => x !== c)));

  return (
    <div data-testid="secrets-consent" style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("coolifyMove.consent.intro")}</p>
      <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifySecrets.consent.neverRead")}</p>
      {active ? (
        <>
          <p role="status" style={{ margin: 0, fontSize: 13 }}>{t("coolifyMove.consent.activeUntil", { when: formatDateTime(active.expiresAt) })}</p>
          {isOwner && (
            <div>
              <Btn variant="ghost" onClick={() => stop.mutate(active.id)} loading={stop.isPending} style={{ minHeight: 44 }}>
                {t("coolifyMove.consent.stop")}
              </Btn>
            </div>
          )}
        </>
      ) : (
        isOwner && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim() === serverName && classes.length > 0 && !allow.isPending) allow.mutate();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyMove.consent.classes")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {COOLIFY_SECRET_CLASSES.map((c) => (
                <div key={c} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minHeight: 44 }}>
                  <Checkbox checked={classes.includes(c)} onChange={(on) => toggle(c, on)} label={t(`coolifySecrets.class.${c}`)} />
                  <Badge tone={COOLIFY_SECRET_TIER[c] === "T1" ? "ok" : "muted"}>{t(`coolifySecrets.tier.${COOLIFY_SECRET_TIER[c]}`)}</Badge>
                </div>
              ))}
            </div>
            <Field label={t("coolifyMove.consent.hours")}>
              <NumberInput min={1} max={COOLIFY_SECRETS_GRANT_MAX_HOURS} value={hours} onChange={(e) => setHours(e.target.value)} style={{ minHeight: 44 }} />
            </Field>
            <Field label={t("coolifyMove.consent.typeHost", { name: serverName })}>
              <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" style={{ minHeight: 44 }} />
            </Field>
            <div>
              <Btn type="submit" disabled={typed.trim() !== serverName || classes.length === 0} loading={allow.isPending} style={{ minHeight: 44 }}>
                {t("coolifyMove.consent.allow")}
              </Btn>
            </div>
          </form>
        )
      )}
      {err && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--c-r)" }}>{consentErrorText(t, err)}</p>}
    </div>
  );
}
