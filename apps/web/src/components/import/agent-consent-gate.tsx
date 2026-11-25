"use client";

import { useT } from "../../i18n/provider";
import type { ImportPlan } from "../../lib/types";
import { needsConsent } from "../../lib/coolify-agent";
import { SectionCard } from "../ui";
import { AgentConsentCard } from "./agent-consent";

/**
 * The consent for secret values, asked again where the apply is: an agent session cannot be applied without it, and it may never have been
 * given (the match step was skipped or the owner pressed "Not now"), have run out, or have ended with an earlier apply. Shown only while the
 * plan says no consent stands; the apply controls beside it stay off until it does. The card never sees a secret value.
 */
export function AgentConsentGate({
  plan,
  sessionId,
  host,
  onChanged,
}: {
  plan: ImportPlan;
  sessionId: string;
  /** The Tugra server whose agent reads Coolify (its name is what the owner types). Null when it is not in the caller's list. */
  host: { id: string; name: string; teamId: string } | null;
  /** The consent changed: the plan is read again so the next screen reflects what now stands. */
  onChanged: () => void;
}) {
  const t = useT();
  if (!needsConsent(plan)) return null;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--c-am)", lineHeight: 1.5 }}>{t("coolifySecrets.consent.applyNeeded")}</p>
      {host && <AgentConsentCard serverId={host.id} serverName={host.name} teamId={host.teamId} sessionId={sessionId} secretCounts={plan.preflight?.agentRead?.secretCounts} standing={null} onChanged={() => onChanged()} />}
    </div>
  );
}
