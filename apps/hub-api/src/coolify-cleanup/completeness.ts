import type { CompletenessKind, CompletenessRow } from "@tugra/shared";

/**
 * The completeness checklist (Coolify hub takeover, lane G): every Coolify item on a server is compared with its Tugra counterpart,
 * kind by kind. Pure: the service loads the two sides, this decides. Names, refs and counts only; no value of any variable, key or
 * credential is ever read here.
 *
 * Matching: a Tugra item that carries the Coolify ref it was created from wins (the importer records it); otherwise the same name
 * (case-insensitive) on the same server. An item without a counterpart is `missing`.
 */

// ---- the Coolify side (from the stored inventory) ----------------------------------------------------------------------

export interface CoolifyApp {
  ref: string;
  name: string;
  /** Environment variable names Coolify holds for it. */
  envKeys: number;
  /** Public hostnames (already reduced to a host, see {@link hostOf}). */
  domains: string[];
  /** Coolify's own docker volume names, or null when this read does not carry them (then the volume row is unreadable). */
  volumes: string[] | null;
  /** The uuid Coolify names its docker objects with. */
  uuid: string;
  running: boolean;
}
export interface CoolifyNamed {
  ref: string;
  name: string;
  uuid: string;
  envKeys: number;
  volumes: string[] | null;
  running: boolean;
  /** Services: how many containers (compose services) Coolify runs for it. Absent when the stored read does not say. */
  components?: number;
}
export interface CoolifyTaskItem {
  name: string;
  /** Name of the application or service it runs in. */
  owner: string;
}
export interface CoolifySide {
  applications: CoolifyApp[];
  databases: CoolifyNamed[];
  services: CoolifyNamed[];
  tasks: CoolifyTaskItem[];
  /** Enabled scheduled database backups, by database name. */
  backups: string[];
  /** Coolify notification channel kinds that are configured. */
  notifications: string[];
}

// ---- the Tugra side (from the hub's own tables) ------------------------------------------------------------------------

export interface TugraApp {
  id: string;
  name: string;
  /** The Coolify ref this was created from, when the importer recorded one. */
  sourceRef: string | null;
  envKeys: number;
  domains: string[];
  /** Logical volume names (`data`), not docker names. */
  volumes: string[];
  tasks: string[];
  running: boolean;
  /** Compose apps: how many services the stored compose declares (the containers the app runs). Absent or null = not a compose app. */
  members?: number | null;
}
export interface TugraDb {
  id: string;
  name: string;
  sourceRef: string | null;
  volumes: string[];
  backupEnabled: boolean;
  running: boolean;
}
export interface TugraSide {
  applications: TugraApp[];
  databases: TugraDb[];
  /** Tugra notification channel types the team has. */
  notificationTypes: string[];
  /**
   * Traffic check per hostname (true = the name resolves to this server AND Tugra answers with a valid certificate for it). Absent = the
   * check did not run: when Coolify served any domain the traffic row is then unreadable, never complete.
   */
  cutover?: Record<string, boolean>;
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

/** `https://App.Example.com:443/path` -> `app.example.com`. Not a hostname -> null. */
export function hostOf(value: string): string | null {
  let v = value.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v.replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v) ? v : null;
}

/** Coolify's comma-separated `fqdn` field -> the unique hostnames in it. */
export function hostsOfFqdn(fqdn: string | null | undefined): string[] {
  if (!fqdn) return [];
  return [...new Set(fqdn.split(",").map(hostOf).filter((h): h is string => !!h))];
}

/**
 * Coolify names a docker volume `<uuid>-<name>` or `<uuid>_<name>` (applications, services) or `<name>-<uuid>` (databases:
 * `postgres-data-<uuid>`); the part beside the uuid is what Tugra calls it. A database's engine data volume (`<engine>-data`) is
 * Tugra's `data`.
 */
export function logicalVolumeName(dockerName: string, uuid: string, isDatabase = false): string {
  if (!uuid) return dockerName;
  if (dockerName.startsWith(`${uuid}-`) || dockerName.startsWith(`${uuid}_`)) return dockerName.slice(uuid.length + 1);
  if (dockerName.endsWith(`-${uuid}`) || dockerName.endsWith(`_${uuid}`)) {
    const base = dockerName.slice(0, dockerName.length - uuid.length - 1);
    return isDatabase && /-data$/.test(base) ? "data" : base;
  }
  return dockerName;
}

/** Does this docker volume belong to the Coolify resource with this uuid (uuid first or last, `-` or `_`)? */
export function volumeBelongsTo(volume: string, uuid: string): boolean {
  return !!uuid && (volume.startsWith(`${uuid}-`) || volume.startsWith(`${uuid}_`) || volume.endsWith(`-${uuid}`) || volume.endsWith(`_${uuid}`));
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Coolify notification channel -> the Tugra channel type that carries it; null = Tugra has no such channel (listed, never counted). */
const CHANNEL_TYPE: Record<string, string | null> = { email: "smtp", discord: "discord", telegram: "telegram", slack: "slack", webhook: "webhook", pushover: null };

function counterpart<T extends { name: string; sourceRef: string | null }>(pool: T[], ref: string, name: string): T | undefined {
  return pool.find((t) => t.sourceRef === ref) ?? pool.find((t) => !t.sourceRef && norm(t.name) === norm(name)) ?? pool.find((t) => norm(t.name) === norm(name));
}

/** A running Coolify item whose Tugra counterpart is not running is not "in Tugra" yet. */
function presence(coolifyRunning: boolean, tugra: { running: boolean } | undefined, name: string): string | null {
  if (!tugra) return name;
  if (coolifyRunning && !tugra.running) return `${name} (not running)`;
  return null;
}

// ---- the comparison ---------------------------------------------------------------------------------------------------

export interface CompletenessResult {
  rows: CompletenessRow[];
  /** Every row complete and every Coolify side readable. */
  complete: boolean;
  /**
   * The Coolify uuids of the items matched COMPLETE one by one (counterpart present and running where Coolify's was, variables, volumes
   * read and present, domains and traffic, tasks, backup). Only these may have their leftovers (containers, directories) removed.
   */
  completeUuids: string[];
}

export function compareCompleteness(coolify: CoolifySide, tugra: TugraSide): CompletenessResult {
  const rows: CompletenessRow[] = [];
  const row = (kind: CompletenessKind, c: number, t: number, missing: string[], extra: Partial<CompletenessRow> = {}): void => {
    rows.push({ kind, coolify: c, tugra: t, missing: [...new Set(missing)].sort(), ...extra });
  };
  /** uuids of items that failed any row: they are never "matched complete". */
  const bad = new Set<string>();
  const appOf = (ref: string, name: string) => counterpart(tugra.applications, ref, name);
  const apps = coolify.applications.map((a) => ({ a, t: appOf(a.ref, a.name) }));
  const svcs = coolify.services.map((s) => ({ s, t: appOf(s.ref, s.name) })); // a Coolify service is a compose app in Tugra
  const dbs = coolify.databases.map((d) => ({ d, t: counterpart(tugra.databases, d.ref, d.name) }));

  const missingOf = (items: Array<{ uuid: string; running: boolean; name: string; t: { running: boolean } | undefined }>): string[] =>
    items
      .map((i) => {
        const m = presence(i.running, i.t, i.name);
        if (m) bad.add(i.uuid);
        return m;
      })
      .filter((x): x is string => !!x);
  const missingApps = missingOf(apps.map(({ a, t }) => ({ uuid: a.uuid, running: a.running, name: a.name, t })));
  row("application", apps.length, apps.length - missingApps.length, missingApps);
  const missingDbs = missingOf(dbs.map(({ d, t }) => ({ uuid: d.uuid, running: d.running, name: d.name, t })));
  row("database", dbs.length, dbs.length - missingDbs.length, missingDbs);
  const missingSvcs = missingOf(svcs.map(({ s, t }) => ({ uuid: s.uuid, running: s.running, name: s.name, t })));
  // A service is complete only with a Tugra container for every container Coolify runs for it: a member the import dropped would be left
  // without a counterpart, and its Coolify container must stay (it is shown, never removed).
  for (const { s, t } of svcs) {
    const have = t?.members;
    if (t && s.components && s.components > 0 && typeof have === "number" && have < s.components && !missingSvcs.some((m) => m === s.name || m.startsWith(`${s.name} (`))) {
      missingSvcs.push(`${s.name} (${have}/${s.components} containers)`);
      bad.add(s.uuid);
    }
  }
  row("service", svcs.length, svcs.length - missingSvcs.length, missingSvcs);

  // Domains: every hostname Coolify served must be a hostname of the matched Tugra app.
  const domainMissing: string[] = [];
  let domainTotal = 0;
  for (const { a, t } of apps) {
    const have = new Set((t?.domains ?? []).map((h) => hostOf(h)).filter((h): h is string => !!h));
    for (const h of a.domains) {
      domainTotal++;
      if (!have.has(h)) {
        domainMissing.push(h);
        bad.add(a.uuid);
      }
    }
  }
  row("domain", domainTotal, domainTotal - new Set(domainMissing).size, domainMissing);

  // Traffic: a hostname only counts when it already resolves to Tugra's server and Tugra answers with a valid certificate for it. Removing
  // Coolify's proxy and certificates while DNS still points at Coolify would be an outage; the owner's fallback would be gone.
  const trafficHosts = new Map<string, string[]>();
  for (const { a } of apps) for (const h of a.domains) trafficHosts.set(h, [...(trafficHosts.get(h) ?? []), a.uuid]);
  const trafficMissing: string[] = [];
  for (const [h, owners] of trafficHosts) {
    if (tugra.cutover?.[h] !== true) {
      trafficMissing.push(h);
      for (const u of owners) bad.add(u);
    }
  }
  row("traffic", trafficHosts.size, trafficHosts.size - trafficMissing.length, trafficMissing, trafficHosts.size > 0 && !tugra.cutover ? { unreadable: true } : {});

  // Variable names: a count per matched item. Tugra may hold more (its own); fewer means something did not come across.
  const envMissing: string[] = [];
  let envCoolify = 0;
  let envTugra = 0;
  for (const { a, t } of apps) {
    envCoolify += a.envKeys;
    envTugra += Math.min(t?.envKeys ?? 0, a.envKeys);
    if ((t?.envKeys ?? 0) < a.envKeys) {
      envMissing.push(a.name);
      bad.add(a.uuid);
    }
  }
  for (const { s, t } of svcs) {
    envCoolify += s.envKeys;
    envTugra += Math.min(t?.envKeys ?? 0, s.envKeys);
    if ((t?.envKeys ?? 0) < s.envKeys) {
      envMissing.push(s.name);
      bad.add(s.uuid);
    }
  }
  row("env_keys", envCoolify, envTugra, envMissing);

  // Volumes: only when every Coolify item carries its volume list; otherwise the row says it cannot tell.
  const volItems: Array<{ name: string; uuid: string; db: boolean; volumes: string[] | null; t: { volumes: string[] } | undefined }> = [
    ...apps.map(({ a, t }) => ({ name: a.name, uuid: a.uuid, db: false, volumes: a.volumes, t })),
    ...svcs.map(({ s, t }) => ({ name: s.name, uuid: s.uuid, db: false, volumes: s.volumes, t })),
    ...dbs.map(({ d, t }) => ({ name: d.name, uuid: d.uuid, db: true, volumes: d.volumes, t })),
  ];
  const unreadableVolumes = volItems.some((v) => v.volumes === null);
  const volMissing: string[] = [];
  let volTotal = 0;
  for (const v of volItems) {
    if (v.volumes === null) bad.add(v.uuid);
    const have = new Set((v.t?.volumes ?? []).map(norm));
    for (const dockerName of v.volumes ?? []) {
      volTotal++;
      const logical = logicalVolumeName(dockerName, v.uuid, v.db);
      if (!have.has(norm(logical))) {
        volMissing.push(`${v.name}/${logical}`);
        bad.add(v.uuid);
      }
    }
  }
  row("volume", volTotal, volTotal - volMissing.length, volMissing, unreadableVolumes ? { unreadable: true } : {});

  // Scheduled tasks: by owner and task name.
  const taskMissing: string[] = [];
  for (const task of coolify.tasks) {
    const owner = counterpart(tugra.applications, "", task.owner);
    if (!owner || !owner.tasks.map(norm).includes(norm(task.name))) {
      taskMissing.push(`${task.owner}/${task.name}`);
      for (const x of [...apps.map(({ a }) => a), ...svcs.map(({ s }) => s)]) if (norm(x.name) === norm(task.owner)) bad.add(x.uuid);
    }
  }
  row("scheduled_task", coolify.tasks.length, coolify.tasks.length - taskMissing.length, taskMissing);

  // Backups: each enabled Coolify database backup needs the matching Tugra database to have its own backups on.
  const backupMissing: string[] = [];
  const backupNames = [...new Set(coolify.backups.map(norm))];
  for (const name of backupNames) {
    const db = tugra.databases.find((d) => norm(d.name) === name);
    if (!db?.backupEnabled) {
      backupMissing.push(name);
      for (const { d } of dbs) if (norm(d.name) === name) bad.add(d.uuid);
    }
  }
  row("backup", backupNames.length, backupNames.length - backupMissing.length, backupMissing);

  // Notifications: channel kinds Tugra can send are compared; the others are shown, never counted.
  const kinds = [...new Set(coolify.notifications.map(norm))];
  const carried = kinds.filter((k) => CHANNEL_TYPE[k] !== null);
  const notCarried = kinds.filter((k) => CHANNEL_TYPE[k] === null);
  const haveTypes = new Set(tugra.notificationTypes.map(norm));
  const notifMissing = carried.filter((k) => !haveTypes.has(CHANNEL_TYPE[k] ?? k));
  row("notification", carried.length, carried.length - notifMissing.length, notifMissing, notCarried.length ? { notCarried } : {});

  const all = [...apps.map(({ a }) => a.uuid), ...svcs.map(({ s }) => s.uuid), ...dbs.map(({ d }) => d.uuid)];
  return { rows, complete: isComplete(rows), completeUuids: [...new Set(all.filter((u) => u && !bad.has(u)))] };
}

/** Complete = nothing missing anywhere and no row that could not be read. An unreadable row is never "complete". */
export function isComplete(rows: readonly CompletenessRow[]): boolean {
  return rows.length > 0 && rows.every((r) => !r.unreadable && r.missing.length === 0 && r.tugra >= r.coolify);
}
