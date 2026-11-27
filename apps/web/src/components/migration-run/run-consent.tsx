"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import type { MigrationRunSecretsConsent, MigrationRunView } from "../../lib/types";
import { AgentConsentCard } from "../import/agent-consent";
import { Working } from "../ui";

const OPEN = new Set(["QUEUED", "RUNNING", "WAITING", "PAUSED", "FAILED"]);
/** How often the page asks the hub whether the consent still stands (the owner can withdraw it, another owner's can replace it, the session ends). */
const POLL_MS = 15_000;

export const consentQueryKey = (runId: string, sessionId: string | null) => ["migration-run-secrets-consent", runId, sessionId] as const;

/**
 * Does the owner's consent for secret values stand for the session this run imports through? Asked of the hub, never worked out here.
 * `sessionId` is the renewed session a promotion would use (else the run's own). Only a real run on an agent session has one to ask for.
 */
export function useRunConsent(run: MigrationRunView, opts: { enabled: boolean; sessionId?: string | null }) {
  const sessionId = opts.sessionId ?? null;
  return useQuery<MigrationRunSecretsConsent>({
    queryKey: consentQueryKey(run.id, sessionId),
    queryFn: () => api.getMigrationRunSecretsConsent(run.id, sessionId ?? undefined),
    enabled: opts.enabled && !run.inPlace,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/** Is this a real run that still has to import (so it needs the consent)? A dry run applies nothing; a settled run is over. */
export const runNeedsConsent = (run: Pick<MigrationRunView, "dryRun" | "status" | "inPlace">): boolean => !run.dryRun && !run.inPlace && OPEN.has(run.status);

/** True when the hub says the consent applies and does not stand: the run cannot start (or import) until it is given. */
export const consentMissing = (c: MigrationRunSecretsConsent | undefined): boolean => !!c && c.applies && !c.standing;

/**
 * The consent card where the run is: a guided run reads secret values through its agent session, and the consent is the owner's, given for
 * THAT session. A run (or a promotion on a renewed session) without it says so here and lets the owner allow it, instead of failing at its
 * import step. Shown while the consent is missing, and kept (with its "Stop allowing") for the rest of the visit once it was just given.
 */
export function RunConsentPanel({ run, consent, onChanged }: { run: Pick<MigrationRunView, "id">; consent: MigrationRunSecretsConsent | undefined; onChanged?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [touched, setTouched] = useState(false);
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers(), staleTime: 15_000 });
  if (!consent || !consent.applies || !consent.sessionId || (consent.standing && !touched)) return null;
  const host = servers.data?.find((s) => s.id === consent.serverId);
  return (
    <div data-testid="run-consent" style={{ display: "grid", gap: 10 }}>
      {!consent.standing && <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--c-am)", lineHeight: 1.5 }}>{t("migrationRun.consent.needed")}</p>}
      {servers.isLoading ? (
        <Working text={t("migrationRun.consent.loading")} />
      ) : host ? (
        <AgentConsentCard
          key={consent.sessionId}
          serverId={host.id}
          serverName={host.name}
          teamId={host.teamId}
          sessionId={consent.sessionId}
          standing={consent.standing ? (consent.classes as never) : null}
          onChanged={(g) => {
            if (g) setTouched(true);
            void qc.invalidateQueries({ queryKey: ["migration-run-secrets-consent", run.id] });
            onChanged?.();
          }}
        />
      ) : (
        <p role="alert" data-testid="run-consent-host-missing" style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{t("migrationRun.consent.hostMissing")}</p>
      )}
    </div>
  );
}
