"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { agentReadyServers } from "../../lib/coolify-agent-connect";
import { needsTeamChoice } from "../../lib/coolify-take-over";
import type { ImportAgentSession, ServerView } from "../../lib/types";
import { Btn, Working } from "../ui";
import { Select } from "../form";
import { useToast } from "../toast";
import { AgentConsentCard, useTeamRoles } from "./agent-consent";
import { AgentTeamPick } from "./agent-team-pick";

type T = ReturnType<typeof useT>;

export function errorText(t: T, e: unknown): string {
  if (e instanceof ApiError) {
    const key = `coolifyAgent.error.${e.code ?? ""}`;
    const text = t(key);
    if (e.code && text !== key) return text;
    if (e.status === 403) return t("coolifyAgent.error.forbidden");
    if (e.status === 409) return t("coolifyAgent.error.agent_offline");
  }
  return t("coolifyAgent.error.generic");
}

const COUNT_KEYS = ["teams", "projects", "servers", "applications", "databases", "services"] as const;

/**
 * "Through the Coolify server agent": the second way to connect Coolify in the import wizard. Pick the Tugra server where Coolify runs,
 * read it once (read-only, nothing changed or stopped), ask for consent to read secret values, then match the servers. No token, no URL.
 */
export function AgentConnectPanel({
  servers,
  onConnected,
  busy,
}: {
  servers: ServerView[];
  /** The session is ready (read done); the wizard plans it and shows the match step. */
  onConnected: (session: ImportAgentSession, server: { id: string; name: string; teamId: string }) => void;
  busy?: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const candidates = agentReadyServers(servers);
  const [serverId, setServerId] = useState("");
  const [needsOptIn, setNeedsOptIn] = useState(false);
  const [session, setSession] = useState<ImportAgentSession | null>(null);
  // Several Coolify teams: the one whose settings the session reads. Empty until the owner picks; nothing is chosen for them.
  const [teamRef, setTeamRef] = useState("");
  const server = candidates.find((s) => s.id === serverId) ?? null;
  const roles = useTeamRoles();
  // Connecting and matching are open to admins, but the move itself (the consent for secret values, the checks and installs on the servers,
  // the launch) is an owner's: said before anything is read, not after the work is done.
  const notOwner = !!server && !roles.isOwner(server.teamId);

  // A session made here and never handed to the wizard (the owner switched the source or the way to connect, or left) is ended with its
  // consent: nothing is left standing for the rest of its hour. Once Continue hands it over, the wizard owns it.
  const live = useRef<{ id: string | null; handedOver: boolean }>({ id: null, handedOver: false });
  useEffect(() => {
    live.current.id = session?.sessionId ?? null;
  }, [session]);
  useEffect(
    () => () => {
      const l = live.current;
      if (l.id && !l.handedOver) api.importRevoke(l.id).catch(() => undefined);
    },
    [],
  );

  const { data: detect, isFetching: detecting } = useQuery({ queryKey: ["coolify-detect", serverId], queryFn: () => api.coolifyDetect(serverId), enabled: !!serverId && !session, retry: false, staleTime: 30_000 });

  const connect = useMutation({
    mutationFn: async (optIn: boolean) => {
      if (optIn) await api.coolifyEnable(serverId);
      return api.importConnectAgent({ teamId: server!.teamId, serverId });
    },
    onSuccess: (s) => {
      setNeedsOptIn(false);
      setSession(s);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "not_enabled") {
        setNeedsOptIn(true);
        return;
      }
      toast(errorText(t, e), "error");
    },
  });

  // Picking a team makes a new session that carries it (the hub reads the settings of that team); the first one is ended.
  const pickTeam = useMutation({
    mutationFn: async (ref: string) => {
      const next = await api.importConnectAgent({ teamId: server!.teamId, serverId, sourceTeamRef: ref });
      if (session) api.importRevoke(session.sessionId).catch(() => undefined);
      return { next, ref };
    },
    onSuccess: ({ next, ref }) => {
      live.current.handedOver = false; // a new session: it is this panel's again until Continue
      setSession(next);
      setTeamRef(ref);
    },
    onError: (e) => toast(errorText(t, e), "error"),
  });

  if (session && server) {
    const teamOpen = needsTeamChoice(session.teams) && !teamRef;
    const counts = session.read.counts;
    const secretTotal = Object.values(session.read.secretCounts ?? {}).reduce((a, b) => a + b, 0);
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <section aria-label={t("coolifyAgent.connect.found")} style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)" }}>{t("coolifyAgent.connect.found")}</div>
          <ul style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", margin: 0, padding: 0, listStyle: "none", fontSize: 13, color: "var(--c-tx2)" }}>
            {COUNT_KEYS.map((k) => (
              <li key={k}>{t(`coolifyAgent.counts.${k}`)}: <strong>{counts[k]}</strong></li>
            ))}
          </ul>
          {session.read.coolifyImage && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyAgent.connect.version", { version: session.read.coolifyImage.split(":").pop() ?? "" })}</p>}
          {secretTotal > 0 && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyAgent.connect.secretsFound")}: {secretTotal}</p>}
          <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyAgent.read.nothingChanged")}</p>
        </section>

        {needsTeamChoice(session.teams) && (
          <AgentTeamPick teams={session.teams ?? []} value={pickTeam.isPending ? pickTeam.variables ?? "" : teamRef} onChange={(ref) => pickTeam.mutate(ref)} disabled={pickTeam.isPending} />
        )}
        {pickTeam.isPending && <Working text={t("coolifyAgent.team.reading", { team: session.teams?.find((tm) => tm.ref === pickTeam.variables)?.name ?? "" })} />}

        {!teamOpen && <AgentConsentCard key={session.sessionId} serverId={server.id} serverName={server.name} teamId={server.teamId} sessionId={session.sessionId} secretCounts={session.read.secretCounts} />}

        <div style={{ display: "grid", gap: 6 }}>
          <Btn
            onClick={() => {
              live.current.handedOver = true;
              onConnected(session, { id: server.id, name: server.name, teamId: server.teamId });
            }}
            disabled={busy || teamOpen} loading={pickTeam.isPending}>{t("coolifyAgent.connect.continue")}</Btn>
          {!pickTeam.isPending && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{teamOpen ? t("coolifyAgent.team.pickFirst") : t("coolifyAgent.connect.continueHint")}</p>}
        </div>
      </div>
    );
  }

  // Nothing is read or opted in on a server until its agent has found Coolify there.
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("coolifyAgent.subtitle")}</p>
      {candidates.length === 0 ? (
        <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--c-am)", lineHeight: 1.5 }}>{t("coolifyAgent.connect.noServers")}</p>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          <label htmlFor="agent-server" style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)" }}>{t("coolifyAgent.connect.serverLabel")}</label>
          <Select
            id="agent-server"
            value={serverId}
            onChange={(v) => {
              setServerId(v);
              setNeedsOptIn(false);
              connect.reset();
            }}
            placeholder={t("coolifyAgent.connect.serverPlaceholder")}
            options={candidates.map((s) => ({ value: s.id, label: s.online ? s.name : t("coolifyAgent.connect.serverOffline", { name: s.name }), disabled: !s.online }))}
            style={{ maxWidth: 420 }}
          />
          <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifyAgent.connect.serverHint")}</p>
        </div>
      )}

      {notOwner && (
        <p role="alert" data-testid="agent-owner-needed" style={{ margin: 0, fontSize: 13, color: "var(--c-am)", lineHeight: 1.5 }}>
          {t("coolifyAgent.connect.ownerNeeded", { team: roles.nameOf(server!.teamId) })}
        </p>
      )}

      {serverId && detecting && !detect && <Working text={t("coolifyAgent.connect.detecting", { name: server?.name ?? "" })} />}
      {serverId && detect?.found === true && !connect.isPending && (
        <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--c-g)", lineHeight: 1.5 }}>{t("coolifyAgent.connect.detected", { name: server?.name ?? "" })}</p>
      )}
      {serverId && detect && !detect.found && (
        <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{t(`coolifyAgent.error.${detect.reason === "no_docker" ? "no_docker" : detect.reason === "db_stopped" ? "db_stopped" : "no_coolify"}`)}</p>
      )}

      {needsOptIn && (
        <div role="note" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, display: "grid", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)" }}>{t("coolifyAgent.connect.optInTitle")}</div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("coolifyAgent.connect.optIn")}</p>
        </div>
      )}

      <div style={{ display: "grid", gap: 6 }}>
        <Btn onClick={() => connect.mutate(needsOptIn)} disabled={!serverId || busy || notOwner || detect?.found !== true} loading={connect.isPending}>
          {connect.isPending ? t("coolifyAgent.read.reading") : needsOptIn ? t("coolifyAgent.connect.optInButton") : t("coolifyAgent.read.button")}
        </Btn>
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyAgent.read.nothingChanged")}</p>
      </div>
    </div>
  );
}
