"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Browser-safe subpaths: the package index also carries Node-only helpers (node:net) that must not reach the web bundle.
import { COOLIFY_SECRET_CLASSES, COOLIFY_SECRET_TIER } from "@tugra/shared/dist/coolify-secrets";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { formatDateTime } from "../../lib/format-time";
import { classCount, consentReady, defaultClasses, grantLive, isReadByImport, missingForApply, type CoolifyHostGrantView, type CoolifySecretClass } from "../../lib/coolify-agent";
import { Badge, Btn, SectionCard } from "../ui";
import { Checkbox } from "../form";
import { useToast } from "../toast";
import { TypedConfirmField } from "../typed-confirm-field";

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

/** How often a card that shows "Allowed" asks the hub whether that is still true (another owner's consent, a withdrawal, the window). */
const REVALIDATE_MS = 20_000;

/**
 * Is the caller an owner of a team? Moving a Coolify off a host needs its team's owner (consent for secret values, host checks and installs,
 * the campaign launch), while connecting and matching are open to admins: the wizard says so up front. Unknown (teams not loaded) counts as
 * an owner: the hub decides, and says so when a member tries.
 */
export function useTeamRoles(): { isOwner: (teamId: string) => boolean; nameOf: (teamId: string) => string } {
  const { data: teams } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams(), staleTime: 60_000, retry: false });
  return {
    isOwner: (teamId) => {
      const team = teams?.find((x) => x.id === teamId);
      return !team?.role || team.role === "OWNER";
    },
    nameOf: (teamId) => teams?.find((x) => x.id === teamId)?.name ?? "",
  };
}

/**
 * The owner's consent for reading Coolify's secret values for ONE import session (Coolify hub takeover). The values are decrypted on the
 * Coolify server and sealed for the hub; this card never sees one. Consent is the host's name, typed; tier-1 classes the import reads are
 * ticked, notification tokens are not; and the consent ends with the session (never longer than it), with the import, or when you stop it.
 * Team owners only: a member is told so up front (the hub enforces it too). What the card shows as "Allowed" is checked against the hub
 * every few seconds and when the window is focused again: a consent that was replaced, withdrawn or has run out is not shown as standing.
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
  const roles = useTeamRoles();
  const owner = roles.isOwner(teamId);
  const teamName = roles.nameOf(teamId);
  const [classes, setClasses] = useState<Set<CoolifySecretClass>>(() => new Set(defaultClasses()));
  const [grant, setGrant] = useState<CoolifyHostGrantView | null>(null);
  const [ended, setEnded] = useState(false);

  // Find the consent after a reload (it stands but this card has no grant to show), and keep checking one this card made.
  const watching = !!standing || !!grant;
  const { data: listed } = useQuery({
    queryKey: ["coolify-secret-grants", teamId],
    queryFn: () => api.coolifySecretsGrants(teamId),
    enabled: watching,
    refetchInterval: watching ? REVALIDATE_MS : false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const mine = grant ? (listed?.find((g) => g.id === grant.id) ?? grant) : null;
  const lapsed = !!mine && !grantLive(mine);
  useEffect(() => {
    // The grant this card made is no longer in force (withdrawn, replaced by another owner's consent for the same host, or its window ran out).
    if (grant && lapsed) {
      setGrant(null);
      setEnded(true);
      void qc.invalidateQueries({ queryKey: ["coolify-secret-grants", teamId] });
      onChanged?.(null);
    }
  }, [grant, lapsed, onChanged, qc, teamId]);
  const active = (lapsed ? null : mine) ?? (grant ? null : (listed?.find((g) => g.serverId === serverId && g.kind === "secrets" && grantLive(g)) ?? null));
  const allowed = !ended && (!!active || !!standing);

  const allow = useMutation({
    mutationFn: () =>
      // no window is asked for: the hub ends the consent with the session, which is the longest an import can use it
      api.coolifySecretsGrant({ serverId, confirm: typed, importSessionId: sessionId, classes: COOLIFY_SECRET_CLASSES.filter((c) => classes.has(c)) }),
    onSuccess: (g) => {
      setGrant(g);
      setEnded(false);
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
      setEnded(false);
      void qc.invalidateQueries({ queryKey: ["coolify-secret-grants", teamId] });
      onChanged?.(null);
    },
    onError: (e) => toast(errorText(t, e), "error"),
  });

  const ready = consentReady(typed, serverName) && classes.size > 0;
  const missing = missingForApply(classes);
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

  if (!owner) {
    return (
      <SectionCard title={t("coolifySecrets.consent.title")} desc={t("coolifySecrets.consent.summary", { host: serverName })}>
        <p role="status" data-testid="consent-owner-only" style={{ margin: 0, fontSize: 13, color: "var(--c-am)", lineHeight: 1.5 }}>
          {t("coolifySecrets.consent.ownerOnly")} {t("coolifySecrets.consent.ownerOnlyWhy", { team: teamName })}
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title={t("coolifySecrets.consent.title")} desc={t("coolifySecrets.consent.summary", { host: serverName })}>
      {ended && <p role="alert" data-testid="consent-ended" style={{ margin: "0 0 12px", fontSize: 13, color: "var(--c-am)", lineHeight: 1.5 }}>{t("coolifySecrets.consent.ended")}</p>}
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: 8 }}>
        <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", padding: 0, marginBottom: 6 }}>{t("coolifySecrets.consent.classes")}</legend>
        {COOLIFY_SECRET_CLASSES.map((c) => {
          const n = classCount(secretCounts, c);
          const t2 = COOLIFY_SECRET_TIER[c] === "T2";
          // a class no import reads yet is listed so nothing is hidden, but it cannot be allowed: allowing it would grant nothing the import uses
          const used = isReadByImport(c);
          return (
            <Checkbox
              key={c}
              checked={used && classes.has(c)}
              disabled={!used}
              onChange={(on) => toggle(c, on)}
              label={
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" }}>
                  <span>{t(`coolifySecrets.class.${c}`)}</span>
                  {n !== null && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("coolifySecrets.consent.count", { n })}</span>}
                  {used && t2 && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("coolifySecrets.tier.T2")}</span>}
                  {!used && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("coolifySecrets.consent.notUsed")}</span>}
                </span>
              }
            />
          );
        })}
      </fieldset>
      {missing.length > 0 && (
        <p role="note" data-testid="consent-missing" style={{ margin: "10px 0 0", fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>
          {t("coolifySecrets.consent.missingNote", { classes: missing.map((c) => t(`coolifySecrets.class.${c}`)).join(", ") })}
        </p>
      )}
      <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifySecrets.consent.t2Note")}</p>
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifySecrets.consent.neverRead")}</p>

      <div style={{ marginTop: 14 }}>
        <TypedConfirmField
          id="consent-host"
          expected={serverName}
          value={typed}
          onChange={setTyped}
          label={t("coolifySecrets.consent.typeHost")}
          hint={`${t("coolifySecrets.consent.hostName", { name: serverName })} ${t("coolifySecrets.consent.typeHostHint")}`}
        />
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
        <Btn onClick={() => allow.mutate()} disabled={!ready} loading={allow.isPending}>{t("coolifySecrets.consent.button")}</Btn>
        {onSkip && <Btn variant="ghost" onClick={onSkip}>{t("coolifySecrets.consent.skip")}</Btn>}
      </div>
    </SectionCard>
  );
}
