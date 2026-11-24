"use client";

import Link from "next/link";
import { useT } from "../i18n/provider";
import { relativeTime } from "../lib/fleet";
import { coolifyVersion, groupByTeam, importHref, statusTone, type CoolifyInventoryView, type InvServer, type InventoryItem, type TeamGroup } from "../lib/coolify-takeover";
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

function Server({ s }: { s: InvServer }) {
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
      <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyTakeover.server.counts", { apps: s.apps, databases: s.databases, services: s.services })}</span>
    </li>
  );
}

function Item({ item, href }: { item: InventoryItem; href: string }) {
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
      <Link href={href} className="tg-link" aria-label={t("coolifyTakeover.item.moveLabel", { name: item.name })} style={{ fontSize: 13, minHeight: 44, display: "inline-flex", alignItems: "center", padding: "0 8px" }}>
        {t("coolifyTakeover.item.move")}
      </Link>
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

function Team({ g, open, href }: { g: TeamGroup; open: boolean; href: string }) {
  const t = useT();
  const items = g.projects.reduce((n, p) => n + p.items.length, 0);
  const name = g.team?.name ?? t("coolifyTakeover.team.noTeam");
  return (
    <Card style={{ padding: "0 16px" }}>
      <details open={open}>
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
              <Server key={s.id} s={s} />
            ))}
          </Section>
          {g.projects.map((p) => (
            <Section key={p.id || "none"} title={p.name ?? t("coolifyTakeover.team.noProject")} count={p.items.length}>
              {p.items.map((i) => (
                <Item key={i.key} item={i} href={href} />
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

/** The stored, read-only copy of a Coolify, one card per Coolify team. Every item links to the existing import for the actual move. */
export function CoolifyInventoryBody({ inv }: { inv: CoolifyInventoryView }) {
  const t = useT();
  const data = inv.data;
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
        <Team key={g.id || "none"} g={g} open={i === 0} href={importHref(data.instance.fqdn)} />
      ))}
      {inv.readAt && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyTakeover.read.readAt", { when: relativeTime(inv.readAt) })}</p>}
    </div>
  );
}
