"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MoveOffServerRow } from "@tugra/shared";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { connectHref } from "../lib/coolify-move";
import { decideTakeOver, guidedRunFor, needsTeamChoice } from "../lib/coolify-take-over";
import { busyServers } from "../lib/launch-guards";
import { rememberImportFocus } from "../lib/import-focus";
import type { ImportAgentSession } from "../lib/types";
import { Btn } from "./ui";
import { AgentTeamPick } from "./import/agent-team-pick";
import { TakeoverStartNote, useTakeoverStartBlock } from "./takeover-start-guard";

/**
 * "Take over in place" for one server: it starts the right flow itself. A takeover or a guided run for this server opens that; with none,
 * the import session is made through the agent path on the Coolify host and the import wizard opens on this server, placed on itself, for
 * the owner to check and continue. Nothing is changed by the click: the session is a read, and the wizard asks before anything runs.
 * Several Coolify teams: the owner picks the team first (no default).
 */
export function CoolifyTakeOverButton({ row, teamId, hubServerId, hubTeamId }: { row: Pick<MoveOffServerRow, "serverId" | "name" | "takeover">; teamId: string; hubServerId: string | null; hubTeamId?: string | null }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<null | "generic" | "noHub" | "notEnabled">(null);
  const [session, setSession] = useState<ImportAgentSession | null>(null);
  const [teamRef, setTeamRef] = useState("");

  const open = (s: ImportAgentSession) => {
    rememberImportFocus({ kind: "coolify", agentSessionId: s.sessionId, inPlaceServerId: row.serverId, fromServerName: row.name });
    router.push("/import");
  };
  const fail = (e: unknown) => {
    setError(e instanceof ApiError && e.code === "not_enabled" ? "notEnabled" : "generic");
    setBusy(false);
  };

  // Before the click: starting a new takeover is refused when another run or takeover holds the server, or Tugra's proxy already serves apps here.
  // A takeover or a guided run that exists is opened, not started again, so it is never refused here.
  const starting = row.takeover === "none" || row.takeover === "GIVEN_BACK";
  const runs = useQuery({ queryKey: ["migration-runs", "takeover-start", teamId], queryFn: () => api.listMigrationRuns({ teamId, active: true, limit: 100 }), enabled: starting, staleTime: 15_000, retry: false });
  const carrying = starting && !!runs.data && !!guidedRunFor(runs.data, row.serverId);
  const holdingRun = starting && !carrying ? (busyServers(runs.data).get(row.serverId) ?? null) : null;
  const block = useTakeoverStartBlock(row.serverId, starting && !carrying && !runs.isLoading, holdingRun);

  // The import session is made in the Coolify host's own team, which is often not the team of the server being taken over.
  const press = async () => {
    setError(null);
    setBusy(true);
    try {
      const next = await decideTakeOver(row, {
        listRuns: () => api.listMigrationRuns({ teamId, limit: 100 }),
      });
      if (next.kind === "open") {
        router.push(next.href);
        return;
      }
      if (!hubServerId) {
        setError("noHub");
        setBusy(false);
        return;
      }
      const s = await api.importConnectAgent({ teamId: hubTeamId ?? teamId, serverId: hubServerId });
      if (needsTeamChoice(s.teams)) {
        setSession(s);
        setBusy(false);
        return;
      }
      open(s);
    } catch (e) {
      fail(e);
    }
  };

  // The team is picked: the first session is ended and a new one carries the team (the hub reads that team's settings).
  const continueWithTeam = async () => {
    if (!session || !hubServerId || !teamRef) return;
    setError(null);
    setBusy(true);
    try {
      const next = await api.importConnectAgent({ teamId: hubTeamId ?? teamId, serverId: hubServerId, sourceTeamRef: teamRef });
      api.importRevoke(session.sessionId).catch(() => undefined);
      open(next);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {session && needsTeamChoice(session.teams) ? (
        <div data-testid="take-over-team" style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("coolifyMove.takeOver.teamTitle")}</div>
          <AgentTeamPick id={`take-over-team-${row.serverId}`} teams={session.teams ?? []} value={teamRef} onChange={setTeamRef} disabled={busy} />
          <div>
            <Btn onClick={continueWithTeam} disabled={busy || !teamRef} loading={busy} style={{ minHeight: 44 }}>
              {t("coolifyMove.takeOver.teamContinue")}
            </Btn>
          </div>
        </div>
      ) : (
        <div>
          <Btn variant="ghost" onClick={press} disabled={busy || !!block} loading={busy} style={{ minHeight: 44 }}>
            {busy ? t("coolifyMove.takeOver.working") : starting ? t("coolifyMove.rowAction.takeoverStart") : t("coolifyMove.rowAction.takeoverOpen")}
          </Btn>
        </div>
      )}
      {block && <TakeoverStartNote block={block} serverId={row.serverId} runId={holdingRun} />}
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--c-r)", lineHeight: 1.5 }}>
          {t(`coolifyMove.takeOver.error.${error}`)}
          {error === "notEnabled" && hubServerId && (
            <>
              {" "}
              <Link href={connectHref(hubServerId)} className="tg-link">{t("coolifyMove.takeOver.error.openHost")}</Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
