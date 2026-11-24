/**
 * Reads the settings of one Coolify team over its REST API (read-only GETs). Every section degrades on its own: an
 * endpoint the instance does not have (older Coolify) is `not_exposed`, a refused read is `forbidden`, anything else
 * `error`. Nothing here guesses: where the API does not answer, the section says so and carries nothing.
 *
 * Endpoints (Coolify v4 API; the notification, shared-variable, scheduled-task, tag and docker-cleanup routes exist from
 * the 4.x releases after 4.7.5 and answer 404 before that):
 *   /notifications/{telegram,discord,slack,pushover,webhook,email}   GET, secrets only with read:sensitive
 *   /team/envs, /projects/{uuid}/envs, /projects/{uuid}/environments/{name}/envs   shared variables
 *   /s3-storages            GET (the API never returns the access key or secret)
 *   /{applications,services}/{uuid}/scheduled-tasks
 *   /servers/{uuid}/docker-cleanup
 *   /tags, /{applications,databases,services}/{uuid}/tags
 *   /team/members
 */
import type { CoolifyClient } from "../sources/coolify.source";
import { mapLimit } from "../sources/map-limit";
import type { Read, RawChannel, SettingsSection, RawServerCleanup, RawSharedVar, RawSettings, RawTag, RawTask, UnavailableReason } from "./settings-types";
import { CHANNEL_KINDS, mergeTags, parseCleanup, parseCoolifyChannel, parseMembers, parseResourceTags, parseSharedRows, parseStorageRows, parseTagNames, parseTaskRows } from "./coolify-settings-map";

const CONCURRENCY = 6;

/** Why a failed GET failed, from the HTTP status the client puts in its error message. */
export function failureReason(e: unknown): UnavailableReason {
  const msg = e instanceof Error ? e.message : "";
  if (/\b(404|405|501)\b/.test(msg)) return "not_exposed";
  if (/\b(401|403)\b/.test(msg)) return "forbidden";
  return "error";
}

type Got<T> = { ok: true; data: T } | { ok: false; reason: UnavailableReason };
async function attempt<T>(client: CoolifyClient, path: string): Promise<Got<T>> {
  try {
    return { ok: true, data: (await client.get<T>(path)) as T };
  } catch (e) {
    return { ok: false, reason: failureReason(e) };
  }
}

/** The reason to report when EVERY read of a section failed: not_exposed only if all of them said so. */
function worst(reasons: UnavailableReason[]): UnavailableReason {
  if (reasons.every((r) => r === "not_exposed")) return "not_exposed";
  return reasons.includes("forbidden") ? "forbidden" : "error";
}

interface Listed {
  uuid: string;
  name: string;
}
const listOf = (rows: unknown): Listed[] =>
  Array.isArray(rows)
    ? rows
        .map((r) => (r && typeof r === "object" ? (r as { uuid?: unknown; name?: unknown }) : {}))
        .filter((r): r is { uuid: string; name?: unknown } => typeof r.uuid === "string" && r.uuid !== "")
        .map((r) => ({ uuid: r.uuid, name: typeof r.name === "string" && r.name ? r.name : r.uuid }))
    : [];

/**
 * `only` limits the read to those sections (the apply reads just what was selected; a section left out is reported as not
 * read, never as data). Without it every section is read (the preview).
 */
export async function readCoolifySettings(client: CoolifyClient, only?: ReadonlySet<SettingsSection>): Promise<RawSettings> {
  // The resource lists are shared by the task and tag reads; fetched at most once each.
  const lists: Partial<Record<"applications" | "services" | "databases" | "servers", Promise<Got<unknown>>>> = {};
  const listing = (kind: "applications" | "services" | "databases" | "servers") => (lists[kind] ??= attempt<unknown>(client, `/${kind}`));

  const skipped = { ok: false, reason: "not_exposed" } as const;
  const want = (section: SettingsSection) => !only || only.has(section);
  const [notifications, sharedVariables, storages, scheduledTasks, serverSettings, tags, members] = await Promise.all([
    want("notifications") ? readNotifications(client) : skipped,
    want("sharedVariables") ? readSharedVariables(client) : skipped,
    want("storages") ? readStorages(client) : skipped,
    want("scheduledTasks") ? readTasks(client, listing) : skipped,
    want("serverSettings") ? readCleanup(client, listing) : skipped,
    want("tags") ? readTags(client, listing) : skipped,
    want("members") ? readMembers(client) : skipped,
  ]);
  return { notifications, sharedVariables, storages, scheduledTasks, serverSettings, tags, members };
}

async function readNotifications(client: CoolifyClient): Promise<Read<RawChannel>> {
  const got = await mapLimit([...CHANNEL_KINDS], CONCURRENCY, async (kind) => ({ kind, res: await attempt<unknown>(client, `/notifications/${kind}`) }));
  const ok = got.filter((g): g is { kind: (typeof got)[number]["kind"]; res: { ok: true; data: unknown } } => g.res.ok);
  const failed = got.flatMap((g) => (g.res.ok ? [] : [g.res.reason]));
  if (ok.length === 0) return { ok: false, reason: worst(failed) };
  const items = ok.map((g) => parseCoolifyChannel(g.kind, g.res.data)).filter((c): c is RawChannel => c !== null);
  return { ok: true, items, ...(failed.some((r) => r !== "not_exposed") ? { partial: true } : {}) };
}

async function readSharedVariables(client: CoolifyClient): Promise<Read<RawSharedVar>> {
  const team = await attempt<unknown>(client, "/team/envs");
  if (!team.ok) return { ok: false, reason: team.reason };
  const items: RawSharedVar[] = parseSharedRows(team.data, "team");
  let partial = false;
  const projects = await attempt<unknown>(client, "/projects");
  if (!projects.ok) return { ok: true, items, partial: true };
  await mapLimit(listOf(projects.data), CONCURRENCY, async (p) => {
    const where = { projectRef: p.uuid, projectName: p.name };
    const [vars, detail] = await Promise.all([attempt<unknown>(client, `/projects/${encodeURIComponent(p.uuid)}/envs`), attempt<unknown>(client, `/projects/${encodeURIComponent(p.uuid)}`)]);
    if (vars.ok) items.push(...parseSharedRows(vars.data, "project", where));
    else partial = true;
    const envs = detail.ok && detail.data && typeof detail.data === "object" ? (detail.data as { environments?: unknown }).environments : undefined;
    if (!detail.ok) partial = true;
    for (const e of listOfNames(envs)) {
      const r = await attempt<unknown>(client, `/projects/${encodeURIComponent(p.uuid)}/environments/${encodeURIComponent(e)}/envs`);
      if (r.ok) items.push(...parseSharedRows(r.data, "environment", { ...where, environmentName: e }));
      else partial = true;
    }
  });
  return { ok: true, items, ...(partial ? { partial } : {}) };
}

const listOfNames = (rows: unknown): string[] => (Array.isArray(rows) ? rows.map((r) => (r && typeof r === "object" ? (r as { name?: unknown }).name : undefined)).filter((n): n is string => typeof n === "string" && n !== "") : []);

async function readStorages(client: CoolifyClient): Promise<Read<ReturnType<typeof parseStorageRows>[number]>> {
  const r = await attempt<unknown>(client, "/s3-storages");
  return r.ok ? { ok: true, items: parseStorageRows(r.data) } : { ok: false, reason: r.reason };
}

type Listing = (kind: "applications" | "services" | "databases" | "servers") => Promise<Got<unknown>>;

async function readTasks(client: CoolifyClient, listing: Listing): Promise<Read<RawTask>> {
  const [apps, services] = await Promise.all([listing("applications"), listing("services")]);
  if (!apps.ok && !services.ok) return { ok: false, reason: worst([apps.reason, services.reason]) };
  const targets = [
    ...(apps.ok ? listOf(apps.data).map((r) => ({ ...r, kind: "application" as const })) : []),
    ...(services.ok ? listOf(services.data).map((r) => ({ ...r, kind: "service" as const })) : []),
  ];
  const results = await mapLimit(targets, CONCURRENCY, async (t) => ({ t, res: await attempt<unknown>(client, `/${t.kind === "application" ? "applications" : "services"}/${encodeURIComponent(t.uuid)}/scheduled-tasks`) }));
  const failed = results.flatMap((x) => (x.res.ok ? [] : [x.res.reason]));
  if (targets.length > 0 && failed.length === targets.length) return { ok: false, reason: worst(failed) };
  const items = results.flatMap((x) => (x.res.ok ? parseTaskRows(x.res.data, { kind: x.t.kind, ref: x.t.uuid, name: x.t.name }) : []));
  return { ok: true, items, ...(failed.length ? { partial: true } : {}) };
}

async function readCleanup(client: CoolifyClient, listing: Listing): Promise<Read<RawServerCleanup>> {
  const servers = await listing("servers");
  if (!servers.ok) return { ok: false, reason: servers.reason };
  const targets = listOf(servers.data);
  const results = await mapLimit(targets, CONCURRENCY, async (s) => ({ s, res: await attempt<unknown>(client, `/servers/${encodeURIComponent(s.uuid)}/docker-cleanup`) }));
  const failed = results.flatMap((x) => (x.res.ok ? [] : [x.res.reason]));
  if (targets.length > 0 && failed.length === targets.length) return { ok: false, reason: worst(failed) };
  const items = results.flatMap((x) => (x.res.ok ? [parseCleanup(x.res.data, { ref: x.s.uuid, name: x.s.name })].filter((c): c is RawServerCleanup => c !== null) : []));
  return { ok: true, items, ...(failed.length ? { partial: true } : {}) };
}

async function readTags(client: CoolifyClient, listing: Listing): Promise<Read<RawTag>> {
  const list = await attempt<unknown>(client, "/tags");
  if (!list.ok) return { ok: false, reason: list.reason };
  const names = parseTagNames(list.data);
  if (names.length === 0) return { ok: true, items: [] };
  const [apps, dbs, services] = await Promise.all([listing("applications"), listing("databases"), listing("services")]);
  const targets = [
    ...(apps.ok ? listOf(apps.data).map((r) => ({ ...r, kind: "application" as const, path: "applications" })) : []),
    ...(dbs.ok ? listOf(dbs.data).map((r) => ({ ...r, kind: "database" as const, path: "databases" })) : []),
    ...(services.ok ? listOf(services.data).map((r) => ({ ...r, kind: "service" as const, path: "services" })) : []),
  ];
  let partial = !apps.ok || !dbs.ok || !services.ok;
  const per = await mapLimit(targets, CONCURRENCY, async (t) => {
    const r = await attempt<unknown>(client, `/${t.path}/${encodeURIComponent(t.uuid)}/tags`);
    if (!r.ok) partial = true;
    return { kind: t.kind, ref: t.uuid, name: t.name, tags: r.ok ? parseResourceTags(r.data) : [] };
  });
  return { ok: true, items: mergeTags(names, per), ...(partial ? { partial } : {}) };
}

async function readMembers(client: CoolifyClient): Promise<Read<ReturnType<typeof parseMembers>[number]>> {
  const r = await attempt<unknown>(client, "/team/members");
  return r.ok ? { ok: true, items: parseMembers(r.data) } : { ok: false, reason: r.reason };
}
