"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { MoveOffHub, MoveOffServerRow } from "@tugra/shared";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { formatDateTime } from "../lib/format-time";
import { relativeTime } from "../lib/fleet";
import { cleanupNeedsRead } from "../lib/coolify-cleanup";
import { GRANT_TONE, MOVE_OFF_HREF, STAGE_TONE, connectHref, readFirstHref, startsTakeoverFlow, takeoverHref, type Tone } from "../lib/coolify-move";
import { Badge, Btn, LinkBtn, SectionCard } from "./ui";
import { CoolifySecretsConsent } from "./coolify-secrets-consent";
import { CoolifyTakeOverButton } from "./coolify-take-over-button";

const li: React.CSSProperties = { borderTop: "1px solid var(--c-bd)", padding: "8px 0", display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center", minWidth: 0, fontSize: 13 };
const label: React.CSSProperties = { fontWeight: 600, flex: "1 1 150px", minWidth: 0 };

function Line({ name, tone, children, link, action, testId }: { name: string; tone?: Tone; children: ReactNode; link?: { href: string; text: string }; action?: ReactNode; testId: string }) {
  return (
    <li style={li} data-testid={testId}>
      <span style={label}>{name}</span>
      {tone ? <Badge tone={tone}>{children}</Badge> : <span style={{ fontSize: 12.5, color: "var(--c-tx2)", overflowWrap: "anywhere" }}>{children}</span>}
      {action}
      {!action && link && (
        <Link href={link.href} className="tg-link" style={{ fontSize: 12.5, minHeight: 44, display: "inline-flex", alignItems: "center" }}>
          {link.text}
        </Link>
      )}
    </li>
  );
}

function HubLines({ hub, serverId, serverName, teamId, isOwner }: { hub: MoveOffHub; serverId: string; serverName: string; teamId: string; isOwner: boolean }) {
  const t = useT();
  const [consentOpen, setConsentOpen] = useState(false);
  const ssh = hub.ssh;
  const secretsText = hub.secrets === "active" && hub.secretsExpiresAt ? t("coolifyMove.line.secrets.active", { when: formatDateTime(hub.secretsExpiresAt) }) : t(`coolifyMove.line.secrets.${hub.secrets}`);
  return (
    <>
      <Line testId="line-read" name={t("coolifyMove.line.read.label")} tone={hub.readAt ? "ok" : "warn"} link={{ href: connectHref(serverId), text: t("coolifyMove.line.read.open") }}>
        {hub.readAt ? (hub.knownServers !== null ? t("coolifyMove.line.read.done", { when: relativeTime(hub.readAt, t), servers: hub.knownServers }) : t("coolifyMove.line.read.doneNoCount", { when: relativeTime(hub.readAt, t) })) : t("coolifyMove.line.read.never")}
      </Line>
      <Line testId="line-agents" name={t("coolifyMove.line.agents.label")} tone={ssh ? (ssh.failed > 0 ? "warn" : ssh.finished ? "ok" : "lapis") : "muted"} link={{ href: connectHref(serverId), text: t("coolifyMove.line.agents.open") }}>
        {ssh ? t("coolifyMove.line.agents.some", { online: ssh.online, total: ssh.total, failed: ssh.failed, pending: ssh.pending }) : t("coolifyMove.line.agents.none")}
      </Line>
      <Line testId="line-secrets" name={t("coolifyMove.line.secrets.label")} tone={GRANT_TONE[hub.secrets]}>
        {secretsText}
      </Line>
      <li style={{ padding: "4px 0 8px" }}>
        <Btn variant="ghost" onClick={() => setConsentOpen((v) => !v)} aria-expanded={consentOpen} style={{ minHeight: 44 }}>
          {t("coolifyMove.consent.open")}
        </Btn>
        {consentOpen && (
          <div style={{ marginTop: 10 }}>
            <CoolifySecretsConsent teamId={teamId} serverId={serverId} serverName={serverName} isOwner={isOwner} />
          </div>
        )}
      </li>
      <Line testId="line-hub-last" name={t("coolifyMove.line.next.label")}>
        {t("coolifyMove.line.hubLast")}
      </Line>
    </>
  );
}

function ManagedLines({ row, teamId, hubServerId, hubTeamId }: { row: MoveOffServerRow; teamId: string; hubServerId: string | null; hubTeamId: string | null }) {
  const t = useT();
  return (
    <>
      <Line testId="line-agent" name={t("coolifyMove.line.agent.label")} tone={row.agentOnline ? "ok" : "danger"}>
        {row.agentOnline ? t("coolifyMove.line.agent.online") : t("coolifyMove.line.agent.offline")}
      </Line>
      <Line
        testId="line-takeover"
        name={t("coolifyMove.line.takeover.label")}
        tone={row.takeover === "none" ? "muted" : row.takeover === "FAILED" ? "danger" : row.takeover === "VERIFIED" ? "ok" : "lapis"}
        link={row.takeover === "none" || row.takeover === "GIVEN_BACK" ? { href: "/import", text: t("coolifyMove.rowAction.takeoverStart") } : { href: takeoverHref(row.serverId), text: t("coolifyMove.line.takeover.open") }}
        action={startsTakeoverFlow(row) ? <CoolifyTakeOverButton row={row} teamId={teamId} hubServerId={hubServerId} hubTeamId={hubTeamId} /> : undefined}
      >
        {row.takeover === "none" ? t("coolifyMove.line.takeover.none") : t(`coolifyInPlace.status.${row.takeover}`)}
      </Line>
      {row.cleanup === "FAILED" && cleanupNeedsRead(row.cleanupFailure) ? (
        // Not a failure: no Coolify read knows this server yet. Say so calmly and point at the read.
        <Line testId="line-cleanup" name={t("coolifyMove.line.cleanup.label")} tone="muted" link={{ href: readFirstHref(hubServerId), text: t("coolifyCleanup.needsReadLink") }}>
          {t("coolifyCleanup.needsRead")}
        </Line>
      ) : (
        <Line testId="line-cleanup" name={t("coolifyMove.line.cleanup.label")} tone={row.cleanup === "none" ? "muted" : row.cleanup === "CLEANED" ? "ok" : row.cleanup === "FAILED" ? "danger" : "warn"}>
          {row.cleanup === "none" ? t("coolifyMove.line.cleanup.none") : t(`coolifyCleanup.status.${row.cleanup}`)}
        </Line>
      )}
      <Line testId="line-next" name={t("coolifyMove.line.next.label")} tone={STAGE_TONE[row.stage]}>
        {t(`coolifyMove.stage.${row.stage}`)}
      </Line>
    </>
  );
}

/**
 * The server page's view of the move off Coolify: one line per thing to do, each with its status and a link to the screen where the owner
 * presses the button. Shown only for a team owner or admin (the hub's status route is theirs) and only for a server Coolify is part of.
 * It reads one secret-free status route; it never acts on a server itself.
 */
export function CoolifyHostCard({ serverId, serverName, teamId, role }: { serverId: string; serverName: string; teamId: string; role: string | undefined }) {
  const t = useT();
  const allowed = role === "OWNER" || role === "ADMIN";
  const q = useQuery({ queryKey: ["coolify-move", teamId], queryFn: () => api.coolifyMoveStatus(teamId), enabled: allowed, refetchInterval: 15_000 });
  const row = q.data?.servers.find((s) => s.serverId === serverId);
  if (!allowed || !q.data || !row || (!row.coolify && !row.isCoolifyHub)) return null;
  const hub = q.data.hub && q.data.hub.serverId === serverId ? q.data.hub : null;
  return (
    <SectionCard title={t("coolifyMove.card.title")} desc={t("coolifyMove.card.desc")} right={<LinkBtn href={MOVE_OFF_HREF} variant="ghost">{t("coolifyMove.card.open")}</LinkBtn>}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="coolify-host-card">
        {row.isCoolifyHub ? (
          hub ? (
            <HubLines hub={hub} serverId={serverId} serverName={serverName} teamId={teamId} isOwner={role === "OWNER"} />
          ) : (
            <Line testId="line-read" name={t("coolifyMove.line.read.label")} tone="muted" link={{ href: connectHref(serverId), text: t("coolifyMove.line.read.open") }}>
              {t("coolifyMove.line.hubLast")}
            </Line>
          )
        ) : (
          <ManagedLines row={row} teamId={teamId} hubServerId={q.data.hub?.serverId ?? null} hubTeamId={q.data.hub?.teamId ?? null} />
        )}
      </ul>
    </SectionCard>
  );
}
