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

/** Coolify names a docker volume `<uuid>-<name>` or `<uuid>_<name>`; the part after the uuid is what Tugra calls it. */
export function logicalVolumeName(dockerName: string, uuid: string): string {
  if (uuid && (dockerName.startsWith(`${uuid}-`) || dockerName.startsWith(`${uuid}_`))) return dockerName.slice(uuid.length + 1);
  return dockerName;
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
}

export function compareCompleteness(coolify: CoolifySide, tugra: TugraSide): CompletenessResult {
  const rows: CompletenessRow[] = [];
  const row = (kind: CompletenessKind, c: number, t: number, missing: string[], extra: Partial<CompletenessRow> = {}): void => {
    rows.push({ kind, coolify: c, tugra: t, missing: [...new Set(missing)].sort(), ...extra });
  };
  const appOf = (ref: string, name: string) => counterpart(tugra.applications, ref, name);
  const apps = coolify.applications.map((a) => ({ a, t: appOf(a.ref, a.name) }));
  const svcs = coolify.services.map((s) => ({ s, t: appOf(s.ref, s.name) })); // a Coolify service is a compose app in Tugra
  const dbs = coolify.databases.map((d) => ({ d, t: counterpart(tugra.databases, d.ref, d.name) }));

  const missingApps = apps.map(({ a, t }) => presence(a.running, t, a.name)).filter((x): x is string => !!x);
  row("application", apps.length, apps.length - missingApps.length, missingApps);
  const missingDbs = dbs.map(({ d, t }) => presence(d.running, t, d.name)).filter((x): x is string => !!x);
  row("database", dbs.length, dbs.length - missingDbs.length, missingDbs);
  const missingSvcs = svcs.map(({ s, t }) => presence(s.running, t, s.name)).filter((x): x is string => !!x);
  row("service", svcs.length, svcs.length - missingSvcs.length, missingSvcs);

  // Domains: every hostname Coolify served must be a hostname of the matched Tugra app.
  const domainMissing: string[] = [];
  let domainTotal = 0;
  for (const { a, t } of apps) {
    const have = new Set((t?.domains ?? []).map((h) => hostOf(h)).filter((h): h is string => !!h));
    for (const h of a.domains) {
      domainTotal++;
      if (!have.has(h)) domainMissing.push(h);
    }
  }
  row("domain", domainTotal, domainTotal - new Set(domainMissing).size, domainMissing);

  // Variable names: a count per matched item. Tugra may hold more (its own); fewer means something did not come across.
  const envMissing: string[] = [];
  let envCoolify = 0;
  let envTugra = 0;
  for (const { a, t } of apps) {
    envCoolify += a.envKeys;
    envTugra += Math.min(t?.envKeys ?? 0, a.envKeys);
    if ((t?.envKeys ?? 0) < a.envKeys) envMissing.push(a.name);
  }
  for (const { s, t } of svcs) {
    envCoolify += s.envKeys;
    envTugra += Math.min(t?.envKeys ?? 0, s.envKeys);
    if ((t?.envKeys ?? 0) < s.envKeys) envMissing.push(s.name);
  }
  row("env_keys", envCoolify, envTugra, envMissing);

  // Volumes: only when every Coolify item carries its volume list; otherwise the row says it cannot tell.
  const volItems: Array<{ name: string; uuid: string; volumes: string[] | null; t: { volumes: string[] } | undefined }> = [
    ...apps.map(({ a, t }) => ({ name: a.name, uuid: a.uuid, volumes: a.volumes, t })),
    ...svcs.map(({ s, t }) => ({ name: s.name, uuid: s.uuid, volumes: s.volumes, t })),
    ...dbs.map(({ d, t }) => ({ name: d.name, uuid: d.uuid, volumes: d.volumes, t })),
  ];
  const unreadableVolumes = volItems.some((v) => v.volumes === null);
  const volMissing: string[] = [];
  let volTotal = 0;
  for (const v of volItems) {
    const have = new Set((v.t?.volumes ?? []).map(norm));
    for (const dockerName of v.volumes ?? []) {
      volTotal++;
      if (!have.has(norm(logicalVolumeName(dockerName, v.uuid)))) volMissing.push(`${v.name}/${logicalVolumeName(dockerName, v.uuid)}`);
    }
  }
  row("volume", volTotal, volTotal - volMissing.length, volMissing, unreadableVolumes ? { unreadable: true } : {});

  // Scheduled tasks: by owner and task name.
  const taskMissing: string[] = [];
  for (const task of coolify.tasks) {
    const owner = counterpart(tugra.applications, "", task.owner);
    if (!owner || !owner.tasks.map(norm).includes(norm(task.name))) taskMissing.push(`${task.owner}/${task.name}`);
  }
  row("scheduled_task", coolify.tasks.length, coolify.tasks.length - taskMissing.length, taskMissing);

  // Backups: each enabled Coolify database backup needs the matching Tugra database to have its own backups on.
  const backupMissing: string[] = [];
  const backupNames = [...new Set(coolify.backups.map(norm))];
  for (const name of backupNames) {
    const db = tugra.databases.find((d) => norm(d.name) === name);
    if (!db?.backupEnabled) backupMissing.push(name);
  }
  row("backup", backupNames.length, backupNames.length - backupMissing.length, backupMissing);

  // Notifications: channel kinds Tugra can send are compared; the others are shown, never counted.
  const kinds = [...new Set(coolify.notifications.map(norm))];
  const carried = kinds.filter((k) => CHANNEL_TYPE[k] !== null);
  const notCarried = kinds.filter((k) => CHANNEL_TYPE[k] === null);
  const haveTypes = new Set(tugra.notificationTypes.map(norm));
  const notifMissing = carried.filter((k) => !haveTypes.has(CHANNEL_TYPE[k] ?? k));
  row("notification", carried.length, carried.length - notifMissing.length, notifMissing, notCarried.length ? { notCarried } : {});

  return { rows, complete: isComplete(rows) };
}

/** Complete = nothing missing anywhere and no row that could not be read. An unreadable row is never "complete". */
export function isComplete(rows: readonly CompletenessRow[]): boolean {
  return rows.length > 0 && rows.every((r) => !r.unreadable && r.missing.length === 0 && r.tugra >= r.coolify);
}
