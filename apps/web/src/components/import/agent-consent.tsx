"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COOLIFY_SECRET_CLASSES, COOLIFY_SECRET_TIER } from "@tugra/shared";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { formatDateTime } from "../../lib/format-time";
import { CONSENT_HOURS, classCount, consentReady, defaultClasses, type CoolifyHostGrantView, type CoolifySecretClass } from "../../lib/coolify-agent";
import { Badge, Btn, SectionCard } from "../ui";
import { Checkbox, Select } from "../form";
import { useToast } from "../toast";

type T = ReturnType<typeof useT>;

/** A localized line for a refused consent call: the hub's stable code when we know it, else a generic one. */
function errorText(t: T, e: unknown): string {
  if (e instanceof ApiError) {
    const key = `coolifySecrets.error.${e.code ?? ""}`;
    const text = t(key);
    if (e.code && text !== key) return text;
    if (e.status === 403) return t("coolifySecrets.error.forbidden");
    if (e.status === 400 && /confirm|name/i.test(e.message)) return t("coolifySecrets.error.name_mismatch");
    if (e.status === 400 || e.status === 404) return t("coolifySecrets.error.expired");
  }
  return t("coolifySecrets.error.generic");
}

/**
 * The owner's consent for reading Coolify's secret values for ONE import session (Coolify hub takeover). The values are decrypted on the
 * Coolify server and sealed for the hub; this card never sees one. Consent is the host's name, typed; tier-1 classes are ticked, tier-2 are
 * not; a window of hours; and the consent ends with the import. Team owners only (the hub enforces it, and says so when a member tries).
 */
export function AgentConsentCard({
  serverId,
  serverName,
  teamId,
  sessionId,
  secretCounts,
  standing,
  onChanged,
  onSkip,
}: {
  serverId: string;
  serverName: string;
  teamId: string;
  sessionId: string;
  /** What the read found, by class (counts only). */
  secretCounts?: Record<string, number>;
  /** The classes the plan says are already allowed for this session (after a reload). */
  standing?: CoolifySecretClass[] | null;
  onChanged?: (grant: CoolifyHostGrantView | null) => void;
  onSkip?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [classes, setClasses] = useState<Set<CoolifySecretClass>>(() => new Set(defaultClasses()));
  const [hours, setHours] = useState("24");
  const [grant, setGrant] = useState<CoolifyHostGrantView | null>(null);

  // After a reload the consent stands but this card has no grant to show: find it (active, this server) so it can be stopped.
  const { data: listed } = useQuery({ queryKey: ["coolify-secret-grants", teamId], queryFn: () => api.coolifySecretsGrants(teamId), enabled: !!standing && !grant, retry: false });
  const active = grant ?? listed?.find((g) => g.serverId === serverId && g.kind === "secrets" && g.status === "active") ?? null;
  const allowed = !!active || !!standing;

  const allow = useMutation({
    mutationFn: () =>
      api.coolifySecretsGrant({ serverId, confirm: typed, importSessionId: sessionId, classes: COOLIFY_SECRET_CLASSES.filter((c) => classes.has(c)), hours: Number(hours) }),
    onSuccess: (g) => {
      setGrant(g);
      setTyped("");
      void qc.invalidateQueries({ queryKey: ["coolify-secret-grants", teamId] });
      onChanged?.(g);
    },
    onError: (e) => toast(errorText(t, e), "error"),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.coolifySecretsRevoke(id),
    onSuccess: () => {
      setGrant(null);
      void qc.invalidateQueries({ queryKey: ["coolify-secret-grants", teamId] });
      onChanged?.(null);
    },
    onError: (e) => toast(errorText(t, e), "error"),
  });

  const ready = consentReady(typed, serverName) && classes.size > 0;
  const toggle = (c: CoolifySecretClass, on: boolean) =>
    setClasses((cur) => {
      const next = new Set(cur);
      if (on) next.add(c);
      else next.delete(c);
      return next;
    });

  if (allowed && !allow.isPending) {
    const shown = active?.classes ?? standing ?? [];
    return (
      <SectionCard title={t("coolifySecrets.standing.title")} desc={t("coolifySecrets.consent.endsWithImport")}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Badge tone="ok">{t("coolifySecrets.status.active")}</Badge>
          {active && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifySecrets.consent.until", { when: formatDateTime(active.expiresAt) })}</span>}
        </div>
        {shown.length > 0 && <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("coolifySecrets.standing.classes", { classes: shown.map((c) => t(`coolifySecrets.class.${c}`)).join(", ") })}</p>}
        {active && (
          <div style={{ marginTop: 12 }}>
            <Btn variant="ghost" onClick={() => stop.mutate(active.id)} loading={stop.isPending}>{t("coolifySecrets.consent.revoke")}</Btn>
          </div>
        )}
      </SectionCard>
    );
  }

  return (
    <SectionCard title={t("coolifySecrets.consent.title")} desc={t("coolifySecrets.consent.summary", { host: serverName })}>
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: 8 }}>
        <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", padding: 0, marginBottom: 6 }}>{t("coolifySecrets.consent.classes")}</legend>
        {COOLIFY_SECRET_CLASSES.map((c) => {
          const n = classCount(secretCounts, c);
          const t2 = COOLIFY_SECRET_TIER[c] === "T2";
          return (
            <Checkbox
              key={c}
              checked={classes.has(c)}
              onChange={(on) => toggle(c, on)}
              label={
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" }}>
                  <span>{t(`coolifySecrets.class.${c}`)}</span>
                  {n !== null && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("coolifySecrets.consent.count", { n })}</span>}
                  {t2 && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("coolifySecrets.tier.T2")}</span>}
                </span>
              }
            />
          );
        })}
      </fieldset>
      <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifySecrets.consent.t2Note")}</p>
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifySecrets.consent.neverRead")}</p>

      <div style={{ display: "grid", gap: 6, marginTop: 14 }}>
        <label htmlFor="consent-hours" style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)" }}>{t("coolifySecrets.consent.hours")}</label>
        <Select id="consent-hours" value={hours} onChange={setHours} options={CONSENT_HOURS.map((h) => ({ value: String(h), label: t("coolifySecrets.consent.hoursOption", { n: h }) }))} style={{ maxWidth: 160 }} />
      </div>

      <div style={{ display: "grid", gap: 6, marginTop: 14 }}>
        <label htmlFor="consent-host" style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)" }}>{t("coolifySecrets.consent.typeHost")}</label>
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>
          {t("coolifySecrets.consent.hostName", { name: serverName })} {t("coolifySecrets.consent.typeHostHint")}
        </p>
        <input id="consent-host" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} style={{ width: "100%", minHeight: 44, boxSizing: "border-box", padding: "8px 12px", fontSize: 14, borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", background: "var(--c-el)", color: "var(--c-tx)", fontFamily: "inherit" }} />
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
        <Btn onClick={() => allow.mutate()} disabled={!ready} loading={allow.isPending}>{t("coolifySecrets.consent.button")}</Btn>
        {onSkip && <Btn variant="ghost" onClick={onSkip}>{t("coolifySecrets.consent.skip")}</Btn>}
      </div>
    </SectionCard>
  );
}
