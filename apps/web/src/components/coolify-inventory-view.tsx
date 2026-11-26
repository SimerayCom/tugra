"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { relativeTime } from "../lib/fleet";
import { coolifyVersion, groupByTeam, statusTone, type CoolifyInventoryView, type InvServer, type InvTeam, type InventoryItem, type TeamGroup } from "../lib/coolify-takeover";
import { rememberImportFocus, type ImportFocus } from "../lib/import-focus";
import { needsTeamChoice } from "../lib/coolify-take-over";
import { Badge, Card } from "./ui";

const KIND = { application: "coolifyTakeover.item.application", database: "coolifyTakeover.item.database", service: "coolifyTakeover.item.service" } as const;
const CHANNEL = {
  email: "coolifyTakeover.team.channel.email",
  discord: "coolifyTakeover.team.channel.discord",
  telegram: "coolifyTakeover.team.channel.telegram",
  slack: "coolifyTakeover.team.channel.slack",
  pushover: "coolifyTakeover.team.channel.pushover",
  webhook: "coolifyTakeover.team.channel.webhook",
} as const;
const SCOPE = { team: "coolifyTakeover.variable.team", project: "coolifyTakeover.variable.project", environment: "coolifyTakeover.variable.environment" } as const;

const row = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 44, borderTop: "1px solid var(--c-bd)", padding: "4px 0" } as const;
const mono = { fontSize: 12, color: "var(--c-tx3)", overflowWrap: "anywhere" } as const;
const sectionTitle = { fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "14px 0 2px" } as const;

/** A Coolify server (by its internal id) that is already a Tugra server. */
type Connected = ReadonlyMap<string, { tugraServerId: string; teamId: string | null }>;

type Target = { serverUuid: string | null; projectUuid: string | null; itemName?: string; connected?: { tugraServerId: string; teamId: string | null } };
/** Opens the import on one row: the Coolify team the row sits in, and what to start from. */
type Open = (key: string, team: InvTeam | null, w: Target) => void;

/**
 * What the import starts from for one row. A server's own link starts from that server. An item's link starts from its project (the
 * smallest thing the import can tick) and never from the whole server it runs on; an item with no project ticks nothing and only says
 * what was clicked. The Tugra server the row is already connected as becomes the target.
 */
function focusFor(w: Target): ImportFocus {
  const start = w.itemName ? (w.projectUuid ? { sourceProjectUuid: w.projectUuid } : {}) : w.serverUuid ? { sourceServerUuid: w.serverUuid } : w.projectUuid ? { sourceProjectUuid: w.projectUuid } : {};
  return {
    kind: "coolify",
    ...start,
    ...(w.itemName ? { fromItemName: w.itemName.slice(0, 120) } : {}),
    ...(w.connected && Object.keys(start).length > 0 ? { targetServerId: w.connected.tugraServerId, ...(w.connected.teamId ? { targetTeamId: w.connected.teamId } : {}) } : {}),
  };
}

/**
 * The import session for this read, made through the same agent (no Coolify API token). A Coolify with several teams reads the settings
 * of the row's own team; when that team cannot be told apart, null: the import then opens on the agent choice and the owner picks.
 */
async function agentSession(inv: CoolifyInventoryView, team: InvTeam | null, teamId: string): Promise<string | null> {
  const first = await api.importConnectAgent({ teamId, serverId: inv.serverId });
  if (!needsTeamChoice(first.teams)) return first.sessionId;
  const ref = team ? first.teams?.find((tm) => tm.ref === team.id || tm.name === team.name)?.ref : undefined;
  api.importRevoke(first.sessionId).catch(() => undefined);
  if (!ref) return null;
  return (await api.importConnectAgent({ teamId, serverId: inv.serverId, sourceTeamRef: ref })).sessionId;
}

function OpenLink({ id, label, open, busy }: { id: string; label: string; open: () => void; busy: boolean }) {
  const t = useT();
  return (
    <a
      href="/import"
      onClick={(e) => {
        e.preventDefault();
        if (!busy) open();
      }}
      aria-busy={busy}
      className="tg-link"
      aria-label={label}
      data-testid={`open-${id}`}
      style={{ fontSize: 13, minHeight: 44, display: "inline-flex", alignItems: "center", padding: "0 8px" }}
    >
      {busy ? t("coolifyTakeover.item.opening") : t("coolifyTakeover.item.open")}
    </a>
  );
}

function Server({ s, team, open, busy, connected, tugraName }: { s: InvServer; team: InvTeam | null; open: Open; busy: string | null; connected?: { tugraServerId: string; teamId: string | null }; tugraName?: string }) {
  const t = useT();
  return (
    <li style={row}>
      <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx)" }}>{s.name}</span>
      {s.isLocal && <Badge tone="lapis">{t("coolifyTakeover.server.local")}</Badge>}
      {s.buildServer && <Badge>{t("coolifyTakeover.server.build")}</Badge>}
      {s.swarm && <Badge>{t("coolifyTakeover.server.swarm")}</Badge>}
      {s.reachable === false && <Badge tone="warn">{t("coolifyTakeover.server.unreachable")}</Badge>}
      <span className="mono" style={{ ...mono, flex: "1 1 160px" }}>
        {s.user}@{s.ip}:{s.port}
      </span>
      {connected && <Badge tone="ok">{tugraName ? t("coolifyTakeover.server.connectedAs", { name: tugraName }) : t("coolifyTakeover.server.connected")}</Badge>}
      <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyTakeover.server.counts", { apps: s.apps, databases: s.databases, services: s.services })}</span>
      <OpenLink id={`server-${s.uuid}`} label={t("coolifyTakeover.item.openServerLabel", { name: s.name })} busy={busy === `server-${s.uuid}`} open={() => open(`server-${s.uuid}`, team, { serverUuid: s.uuid, projectUuid: null, connected })} />
    </li>
  );
}

function Item({ item, team, open, busy, connected }: { item: InventoryItem; team: InvTeam | null; open: Open; busy: string | null; connected?: { tugraServerId: string; teamId: string | null } }) {
  const t = useT();
  return (
    <li style={row}>
      <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx)" }}>{item.name}</span>
      <Badge>{t(KIND[item.kind])}</Badge>
      {item.status && <Badge tone={statusTone(item.status)}>{item.status}</Badge>}
      <span className="mono" style={{ ...mono, flex: "1 1 160px" }}>
        {item.detail ?? ""}
        {item.server ? ` · ${t("coolifyTakeover.item.on", { server: item.server })}` : ""}
        {item.environment ? ` · ${item.environment}` : ""}
      </span>
      <OpenLink id={`item-${item.key}`} label={t("coolifyTakeover.item.moveLabel", { name: item.name })} busy={busy === `item-${item.key}`} open={() => open(`item-${item.key}`, team, { serverUuid: item.serverUuid, projectUuid: item.projectUuid, itemName: item.name, connected })} />
    </li>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section aria-label={title}>
      <h4 style={sectionTitle}>
        {title} · {count}
      </h4>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{children}</ul>
    </section>
  );
}

function Team({ g, expanded, open, busy, connected, tugraNames }: { g: TeamGroup; expanded: boolean; open: Open; busy: string | null; connected: Connected; tugraNames: ReadonlyMap<string, string> }) {
  const t = useT();
  const items = g.projects.reduce((n, p) => n + p.items.length, 0);
  const name = g.team?.name ?? t("coolifyTakeover.team.noTeam");
  return (
    <Card style={{ padding: "0 16px" }}>
      <details open={expanded}>
        <summary style={{ cursor: "pointer", minHeight: 48, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 15, fontWeight: 600 }}>
          <span>{name}</span>
          {g.team?.personal && <Badge>{t("coolifyTakeover.team.personal")}</Badge>}
          {g.team && g.team.members > 0 && <span style={{ fontSize: 12, fontWeight: 400, color: "var(--c-tx3)" }}>{t("coolifyTakeover.team.members", { n: g.team.members })}</span>}
          <span style={{ fontSize: 12, fontWeight: 400, color: "var(--c-tx3)" }}>
            {t("coolifyTakeover.counts.servers")} {g.servers.length} · {t("coolifyTakeover.section.resources")} {items}
          </span>
        </summary>
        <div style={{ paddingBottom: 12 }}>
          {g.team?.description && <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--c-tx3)" }}>{g.team.description}</p>}
          {g.team && g.team.notifications.length > 0 && (
            <p style={{ margin: "4px 0", fontSize: 12, color: "var(--c-tx3)", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span>{t("coolifyTakeover.team.notifications")}</span>
              {g.team.notifications.map((n) => (
                <Badge key={n.channel} tone={n.enabled ? "ok" : "muted"}>
                  {t(CHANNEL[n.channel as keyof typeof CHANNEL] ?? "coolifyTakeover.team.channel.webhook")} · {n.enabled ? t("coolifyTakeover.team.notifyOn") : t("coolifyTakeover.team.notifyConfigured")}
                </Badge>
              ))}
            </p>
          )}
          <Section title={t("coolifyTakeover.section.servers")} count={g.servers.length}>
            {g.servers.map((s) => (
              <Server key={s.id} s={s} team={g.team} open={open} busy={busy} connected={connected.get(s.id)} tugraName={tugraNames.get(connected.get(s.id)?.tugraServerId ?? "")} />
            ))}
          </Section>
          {g.projects.map((p) => (
            <Section key={p.id || "none"} title={p.name ?? t("coolifyTakeover.team.noProject")} count={p.items.length}>
              {p.items.map((i) => (
                <Item key={i.key} item={i} team={g.team} open={open} busy={busy} connected={connected.get(i.serverDbId ?? "")} />
              ))}
            </Section>
          ))}
          <Section title={t("coolifyTakeover.section.variables")} count={g.sharedVariables.length}>
            {g.sharedVariables.map((v, i) => (
              <li key={`${v.scope}-${v.key}-${i}`} style={row}>
                <span className="mono" style={{ fontSize: 13, color: "var(--c-tx)" }}>{v.key}</span>
                <Badge>{t(SCOPE[v.scope])}</Badge>
                {v.environment && <span style={mono}>{v.environment}</span>}
              </li>
            ))}
          </Section>
          <Section title={t("coolifyTakeover.section.tasks")} count={g.tasks.length}>
            {g.tasks.map((k, i) => (
              <li key={`${k.name}-${i}`} style={row}>
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx)" }}>{k.name}</span>
                {!k.enabled && <Badge>{t("coolifyTakeover.task.off")}</Badge>}
                <span className="mono" style={mono}>{k.frequency}</span>
                {k.targetName && <span style={mono}>{k.targetName}</span>}
              </li>
            ))}
          </Section>
          <Section title={t("coolifyTakeover.section.backups")} count={g.backups.length}>
            {g.backups.map((b, i) => (
              <li key={`${b.databaseName}-${i}`} style={row}>
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx)" }}>{b.databaseName ?? b.databaseType}</span>
                {!b.enabled && <Badge>{t("coolifyTakeover.task.off")}</Badge>}
                <span className="mono" style={mono}>{b.frequency}</span>
                <span style={mono}>{b.toS3 ? t("coolifyTakeover.backup.s3", { name: b.s3Name ?? "S3" }) : t("coolifyTakeover.backup.local")}</span>
              </li>
            ))}
          </Section>
          <Section title={t("coolifyTakeover.section.storages")} count={g.storages.length}>
            {g.storages.map((s, i) => (
              <li key={`${s.name}-${i}`} style={row}>
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx)" }}>{s.name}</span>
                <span className="mono" style={mono}>{[s.bucket, s.region, s.endpoint].filter(Boolean).join(" · ")}</span>
                {s.hasKeys && <Badge>{t("coolifyTakeover.storage.keys")}</Badge>}
              </li>
            ))}
          </Section>
          <Section title={t("coolifyTakeover.section.sources")} count={g.gitSources.length}>
            {g.gitSources.map((s, i) => (
              <li key={`${s.name}-${i}`} style={row}>
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx)" }}>{s.name}</span>
                <Badge>{s.kind}</Badge>
                <span className="mono" style={mono}>{[s.organization, s.host].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </Section>
        </div>
      </details>
    </Card>
  );
}

/** The stored, read-only copy of a Coolify, one card per Coolify team. Every item opens the import (through the agent) for the actual move. */
export function CoolifyInventoryBody({ inv }: { inv: CoolifyInventoryView }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const data = inv.data;
  // Which of this Coolify's servers are already Tugra servers (matched by the hub on address): the import then starts on them.
  const checklist = useQuery({ queryKey: ["coolify-servers", inv.serverId], queryFn: () => api.coolifyServers(inv.serverId), staleTime: 30_000, retry: false });
  const { data: tugraServers } = useQuery({ queryKey: ["servers", "all"], queryFn: () => api.listServers(), staleTime: 30_000, retry: false });
  const connected: Connected = new Map(
    (checklist.data?.rows ?? []).filter((r) => (r.state === "already_added" || r.state === "this_server") && r.tugraServerId).map((r) => [r.coolifyServerId, { tugraServerId: r.tugraServerId as string, teamId: r.teamId }] as const),
  );
  const tugraNames = new Map((tugraServers ?? []).map((s) => [s.id, s.name] as const));
  // The import runs through this server's agent too: a session is made first, then the import opens on it.
  const open: Open = (key, team, w) => {
    setBusy(key);
    const focus = focusFor(w);
    agentSession(inv, team, inv.teamId)
      .then((sid) => rememberImportFocus(sid ? { ...focus, agentSessionId: sid } : focus))
      .catch(() => rememberImportFocus(focus))
      .finally(() => router.push("/import"));
  };
  if (!data) return null;
  const groups = groupByTeam(data);
  const version = coolifyVersion(inv.coolifyImage);
  const c = inv.counts;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{data.instance.name ?? data.instance.fqdn ?? inv.serverName}</h2>
          <Badge tone="lapis">{t("coolifyTakeover.head.readOnly")}</Badge>
          {version && <Badge>{t("coolifyTakeover.head.version", { version })}</Badge>}
        </div>
        {c && (
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--c-tx2)" }}>
            {t("coolifyTakeover.counts.applications")} {c.applications} · {t("coolifyTakeover.counts.databases")} {c.databases} · {t("coolifyTakeover.counts.services")} {c.services} · {t("coolifyTakeover.counts.servers")} {c.servers} · {t("coolifyTakeover.counts.projects")} {c.projects}
          </p>
        )}
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyTakeover.item.moveHint")}</p>
        {data.unavailable.length > 0 && <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyTakeover.unavailable", { names: data.unavailable.join(", ") })}</p>}
      </Card>
      {groups.map((g, i) => (
        <Team key={g.id || "none"} g={g} expanded={i === 0} open={open} busy={busy} connected={connected} tugraNames={tugraNames} />
      ))}
      {inv.readAt && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyTakeover.read.readAt", { when: relativeTime(inv.readAt) })}</p>}
    </div>
  );
}
