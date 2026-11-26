import type { CoolifyInventoryData, InvApp, InvDb, InvService } from "../coolify-takeover/coolify-inventory";
import { findHostMatch } from "../coolify-takeover/coolify-install-plan";
import { hostsOfFqdn, volumeBelongsTo, type CoolifySide } from "./completeness";
import { containerBelongsTo, type ScanContainer } from "./remnant-scan";

/**
 * Picking one Coolify server's part out of the stored inventory (Coolify hub takeover, lane G). Pure. The inventory is metadata only
 * (names, counts, flags): there is no value in it to leak.
 */

export interface CoolifySideResult {
  side: CoolifySide;
  /** The Coolify resource uuids on this server: their per-resource docker networks are Coolify's to remove. */
  knownUuids: string[];
  /** Sections the stored read did not carry; the rows built from them cannot count as complete. */
  unreadable: Array<"scheduled_task" | "backup" | "notification">;
}

const runningText = (s: string | null): boolean => !!s && s.toLowerCase().startsWith("running");

/** `volumes` is not in the v1 inventory yet (the full agent read adds it): read it when present, else null = "this read does not say". */
function volumesOf(x: object): string[] | null {
  const v = (x as { volumes?: unknown }).volumes;
  return Array.isArray(v) && v.every((e) => typeof e === "string") ? (v as string[]) : null;
}

export function coolifySideFor(data: CoolifyInventoryData, coolifyServerId: string): CoolifySideResult {
  const apps = data.applications.filter((a: InvApp) => a.serverId === coolifyServerId);
  const dbs = data.databases.filter((d: InvDb) => d.serverId === coolifyServerId);
  const services = data.services.filter((s: InvService) => s.serverId === coolifyServerId);
  const owners = new Set([...apps, ...services].map((x) => x.name.trim().toLowerCase()));
  const dbNames = new Set(dbs.map((d) => d.name.trim().toLowerCase()));
  const teamIds = new Set([...apps, ...dbs, ...services].map((x) => x.teamId).filter((t): t is string => !!t));

  const unavailable = new Set(data.unavailable);
  const unreadable: CoolifySideResult["unreadable"] = [];
  if (unavailable.has("scheduled_tasks")) unreadable.push("scheduled_task");
  if (unavailable.has("backups")) unreadable.push("backup");

  const notifications = new Set<string>();
  for (const t of data.teams) {
    if (!teamIds.has(t.id)) continue;
    for (const n of t.notifications) if (n.enabled || n.configured) notifications.add(n.channel);
  }

  return {
    side: {
      applications: apps.map((a) => ({ ref: a.uuid, name: a.name, uuid: a.uuid, envKeys: a.envCount, domains: hostsOfFqdn(a.fqdn), volumes: volumesOf(a), running: runningText(a.status) })),
      databases: dbs.map((d) => ({ ref: d.uuid, name: d.name, uuid: d.uuid, envKeys: 0, volumes: volumesOf(d), running: runningText(d.status) })),
      services: services.map((s) => ({ ref: s.uuid, name: s.name, uuid: s.uuid, envKeys: s.envCount, volumes: volumesOf(s), running: false, ...(s.components > 0 ? { components: s.components } : {}) })),
      tasks: data.scheduledTasks.filter((t) => t.targetName && owners.has(t.targetName.trim().toLowerCase())).map((t) => ({ name: t.name, owner: t.targetName as string })),
      backups: data.backups.filter((b) => b.enabled && b.databaseName && dbNames.has(b.databaseName.trim().toLowerCase())).map((b) => b.databaseName as string),
      notifications: [...notifications].sort(),
    },
    knownUuids: [...apps, ...dbs, ...services].map((x) => x.uuid).filter(Boolean),
    unreadable,
  };
}

/**
 * Which Coolify server of this inventory is the given Tugra server: the link the "Add all Coolify servers" flow wrote, else the one at the
 * same address (exactly one). Null = this inventory does not know the server.
 */
export function coolifyServerFor(
  data: CoolifyInventoryData,
  links: Record<string, { serverId: string }>,
  server: { id: string; publicIp: string | null; publicIpv6: string | null; hostname: string | null; reportedIps: string[] },
): { id: string; isLocal: boolean } | null {
  const linked = data.servers.find((s) => links[s.id]?.serverId === server.id);
  if (linked) return { id: linked.id, isLocal: linked.isLocal };
  const hits = data.servers.filter((s) => !s.isLocal && findHostMatch(s.ip, [server]).match);
  return hits.length === 1 ? { id: hits[0].id, isLocal: false } : null;
}

const isUp = (c: ScanContainer): boolean => c.state === "running" || c.state === "restarting" || c.state === "paused";

/**
 * Where the stored read carries no volume list for an item (the v1 inventory does not), take the item's volumes from the host: Coolify
 * names a docker volume `<uuid>-<name>`, `<uuid>_<name>` or (databases) `<name>-<uuid>`, and the scan read the volume names. An
 * application or service the host shows no volume for has none. A DATABASE with a running container and no volume found is "unreadable"
 * (its data is somewhere this read cannot see), never a vacuous pass.
 *
 * The running state is also refined from the host: an item with a running container is running, whatever the stored read says (the
 * stored v1 read carries no status for services at all).
 */
export function withHostVolumes(side: CoolifySide, hostVolumes: readonly string[], containers: readonly ScanContainer[] = []): CoolifySide {
  const of = (uuid: string): string[] => hostVolumes.filter((v) => volumeBelongsTo(v, uuid));
  const up = (uuid: string): boolean => !!uuid && containers.some((c) => isUp(c) && containerBelongsTo(c.name, uuid));
  const fill = <T extends { uuid: string; volumes: string[] | null; running: boolean }>(x: T, isDb: boolean): T => {
    const running = x.running || up(x.uuid);
    if (x.volumes !== null) return { ...x, running };
    const found = of(x.uuid);
    if (isDb && found.length === 0 && running) return { ...x, running };
    return { ...x, running, volumes: found };
  };
  return {
    ...side,
    applications: side.applications.map((x) => fill(x, false)),
    databases: side.databases.map((x) => fill(x, true)),
    services: side.services.map((x) => fill(x, false)),
  };
}
