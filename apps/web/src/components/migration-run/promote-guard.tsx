"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { capabilitiesHref } from "../../lib/cta-readiness";
import { promoteBlocks, type PromoteBlock } from "../../lib/launch-guards";
import { readFirstHref } from "../../lib/coolify-move";
import { needsTeamChoice } from "../../lib/coolify-take-over";
import type { ImportAgentSession, MigrationRunView } from "../../lib/types";
import { Btn, LinkBtn } from "../ui";
import { AgentTeamPick } from "../import/agent-team-pick";
import { AgentGapNotice } from "./agent-gap-notice";
import { SourceSessionForm } from "./source-session-card";
import { sessionQueryKey, useFreshSession } from "./use-run-actions";

const note = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--c-am)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } as const;

const TARGET_KEY = {
  offline: "migrationRun.promote.target.offline",
  pending: "migrationRun.promote.target.pending",
  "no-deploy": "migrationRun.promote.target.no-deploy",
} as const;

/**
 * What would make the hub refuse the real run of a finished dry run, known before the click: a target that went offline or lost its deploy
 * grant, and a source session that ended during the review (an hour is short). `blocked` keeps Start off; `node` says why and how to go on.
 */
export function usePromoteGuard(run: MigrationRunView): { blocked: boolean; node: React.ReactNode } {
  const t = useT();
  const fresh = useFreshSession(run.id);
  const done = run.status === "DRY_RUN_DONE";
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers(), enabled: done, staleTime: 15_000 });
  const blocks = done ? promoteBlocks(run, servers.data ?? [], !!fresh) : [];
  // The agents on the source servers are read on the session the promotion would use: only once there is one (an ended session is its own block above).
  const askAgents = done && !run.inPlace && !blocks.some((b) => b.kind === "session");
  const agents = useQuery({
    queryKey: ["migration-run-source-agents", run.id, fresh?.sessionId ?? null],
    queryFn: () => api.getMigrationRunSourceAgents(run.id, fresh?.sessionId),
    enabled: askAgents,
    staleTime: 15_000,
    retry: false,
  });
  const gaps = askAgents ? (agents.data?.gaps ?? []) : [];
  const unverified = askAgents && agents.data?.unverified === true && gaps.length === 0;
  const node = (
    <>
      {blocks.length > 0 ? <PromoteBlocks run={run} blocks={blocks} servers={servers.data ?? []} /> : null}
      {gaps.length > 0 && (
        <div data-testid="promote-agent-gap">
          <AgentGapNotice gaps={gaps} dryRun={false} href={readFirstHref(run.sourceSession?.agentServerId)} />
        </div>
      )}
      {unverified && (
        <p role="alert" data-testid="promote-agents-unverified" style={note}>
          <span style={{ flex: "1 1 240px" }}>{t("coolifyInstall.gap.unverified")}</span>
          <Btn variant="ghost" onClick={() => void agents.refetch()} loading={agents.isFetching} style={{ minHeight: 44 }}>{t("migrationRun.promote.agents.recheck")}</Btn>
        </p>
      )}
    </>
  );
  const blocked = blocks.length > 0 || gaps.length > 0 || unverified;
  return { blocked, node: blocked ? node : null };
}

function PromoteBlocks({ run, blocks, servers }: { run: MigrationRunView; blocks: PromoteBlock[]; servers: Array<{ id: string; teamId: string }> }) {
  const t = useT();
  return (
    <div data-testid="promote-guard" style={{ display: "grid", gap: 8 }}>
      {blocks.map((b) =>
        b.kind === "target" ? (
          <p key={b.serverId} role="alert" data-testid="promote-target-block" style={note}>
            <span style={{ flex: "1 1 240px" }}>{t(TARGET_KEY[b.why], { name: b.name ?? b.serverId })}</span>
            <LinkBtn href={b.why === "no-deploy" ? capabilitiesHref(b.serverId) : `/servers/${encodeURIComponent(b.serverId)}`} variant="ghost" style={{ minHeight: 44 }}>{t("migrationRun.promote.openServer")}</LinkBtn>
          </p>
        ) : b.viaAgent ? (
          <AgentReconnect key="session" run={run} block={b} servers={servers} />
        ) : (
          <div key="session" data-testid="promote-session-token" style={{ display: "grid", gap: 8 }}>
            <p role="alert" style={note}>{t("migrationRun.promote.session.token")}</p>
            <SourceSessionForm runId={run.id} />
          </div>
        ),
      )}
    </div>
  );
}

/** The Coolify read of a finished dry run ended: read it again through the same agent (and the same Coolify team), then start with the new session. */
function AgentReconnect({ run, block, servers }: { run: MigrationRunView; block: Extract<PromoteBlock, { kind: "session" }>; servers: Array<{ id: string; teamId: string }> }) {
  const t = useT();
  const qc = useQueryClient();
  const host = servers.find((s) => s.id === block.agentServerId);
  const [pending, setPending] = useState<ImportAgentSession | null>(null);
  const [teamRef, setTeamRef] = useState("");
  const [failed, setFailed] = useState(false);
  const renewed = (s: { sessionId: string; expiresAt: string }) => {
    qc.setQueryData(sessionQueryKey(run.id), { sessionId: s.sessionId, expiresAt: s.expiresAt });
    setPending(null);
  };
  const connect = useMutation({
    mutationFn: (ref: string) => api.importConnectAgent({ teamId: (host as { teamId: string }).teamId, serverId: block.agentServerId as string, ...(ref ? { sourceTeamRef: ref } : {}) }),
    onSuccess: (s, ref) => {
      setFailed(false);
      // the team the first read used is kept; only a Coolify with several teams and no remembered one asks
      if (!ref && needsTeamChoice(s.teams)) setPending(s);
      else {
        if (ref && pending) api.importRevoke(pending.sessionId).catch(() => undefined);
        renewed(s);
      }
    },
    onError: () => setFailed(true),
  });
  const fresh = useFreshSession(run.id);
  if (!host) return <p role="alert" data-testid="promote-host-missing" style={note}>{t("migrationRun.promote.session.hostMissing")}</p>;
  return (
    <div data-testid="promote-session-agent" style={{ display: "grid", gap: 8 }}>
      <p role="alert" style={note}>{t("migrationRun.promote.session.agent")}</p>
      {pending ? (
        <div data-testid="promote-team" style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("migrationRun.promote.session.teamTitle")}</div>
          <AgentTeamPick id="promote-team-pick" teams={pending.teams ?? []} value={teamRef} onChange={setTeamRef} disabled={connect.isPending} />
          <div>
            <Btn onClick={() => connect.mutate(teamRef)} disabled={!teamRef || connect.isPending} loading={connect.isPending} style={{ minHeight: 44 }}>{t("migrationRun.promote.session.teamContinue")}</Btn>
          </div>
        </div>
      ) : (
        <div>
          <Btn onClick={() => connect.mutate(block.sourceTeamRef ?? "")} disabled={connect.isPending} loading={connect.isPending} style={{ minHeight: 44 }}>{t("migrationRun.promote.session.reconnect")}</Btn>
        </div>
      )}
      {failed && <p role="alert" style={{ ...note, color: "var(--c-r)" }}>{t("migrationRun.promote.session.error")}</p>}
      {fresh && <div style={{ fontSize: 12, color: "var(--c-g)" }}>{t("migrationRun.promote.session.ready", { when: new Date(fresh.expiresAt).toLocaleTimeString() })}</div>}
    </div>
  );
}
