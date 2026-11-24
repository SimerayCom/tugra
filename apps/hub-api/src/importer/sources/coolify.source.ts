import type { ForeignEnv, ForeignFleet, ForeignProject, ServiceBundle } from "../foreign-fleet";
import type { ImportSource, ImportSourceCapabilities, FetchedSecrets, SourceAppExtras, SourceHealthRow } from "../import-source";
import { why } from "../reason";
import { mapLimit } from "./map-limit";
import { buildEnvReport, classifyEnvRow } from "../env-report";
import {
  appStaticFlags,
  buildCoolifyFleet,
  coolifyEngine,
  coolifyNeedsSettings,
  containerPrefixKnown,
  withServerDetail,
  decodeCoolifyDockerfile,
  decodeCoolifyLabels,
  type CoolifyApp,
  type CoolifyBackup,
  type CoolifyS3Storage,
  type CoolifyDatabase,
  type CoolifyEnv,
  type CoolifyServer,
  type CoolifyService,
  type CoolifyVolume,
} from "./coolify-map";
import { coolifyHealthRows, coolifyVersionToken, type CoolifyHealthRow } from "./coolify-health";

/**
 * A minimal authenticated GET client for one Coolify instance. The concrete implementation (base URL +
 * Bearer token + the SSRF-guarded fetch) is supplied by the importer service in S2; the adapter stays
 * transport-agnostic and unit-testable with a fake client.
 */
export interface CoolifyClient {
  get<T>(path: string): Promise<T>;
  /** OPTIONAL: a GET for an endpoint that answers plain text (`GET /version`). A client without it simply reports no version. */
  getText?(path: string): Promise<string>;
}

/**
 * The `coolify` import source (read-only discover). Enumerates a Coolify v4 fleet over its REST API and maps
 * it to a SECRET-FREE {@link ForeignFleet}. discover() runs on a plain read token: passwords, env values,
 * internal_db_url and docker_compose_raw are all `read:sensitive`-gated and simply absent — the fleet carries
 * only non-secret identity + a `secretRef` (the Coolify uuid) per resource for a later sensitive-scoped fetch. From
 * Coolify 4.7 the build / start commands, deploy hooks, Docker options, labels and Dockerfile are gated the same way
 * (and only for a token created by a team admin or owner): a row without them says so in the fleet's warnings.
 */
export class CoolifySource implements ImportSource {
  readonly kind = "coolify" as const;

  constructor(private readonly client: CoolifyClient) {}

  capabilities(): ImportSourceCapabilities {
    // discover is API-only; moving DB data / volume bytes needs SSH or a dump API.
    return { apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false };
  }

  async verify(): Promise<{ ok: boolean; version?: string; detail?: string }> {
    try {
      // GET /servers needs a valid token + a reachable Coolify API; a non-array means the base path is wrong.
      const servers = await this.client.get<CoolifyServer[]>("/servers");
      if (!Array.isArray(servers)) return { ok: false, detail: "unexpected response — is the URL a Coolify API root?" };
      // The version is best effort (GET /version answers plain text and needs no extra ability): a source that does not say
      // leaves it unknown for the run's PREFLIGHT to judge. Reading it never fails the verification.
      const version = await this.readVersion();
      return version ? { ok: true, version } : { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "verification failed" };
    }
  }

  private async readVersion(): Promise<string | null> {
    try {
      return this.client.getText ? coolifyVersionToken(await this.client.getText("/version")) : null;
    } catch {
      return null;
    }
  }

  /**
   * Health of every app, database and service right now, from the list rows' `status` and `restart_count` (read-only, the same
   * reads discover() makes). A failed core read throws: a half-read baseline would classify the missing resources as healthy.
   * The per-server resource lists only place a resource on its host; losing one leaves that resource's `serverRef` unset.
   */
  async healthBaseline(): Promise<SourceHealthRow[]> {
    const servers = (await this.client.get<CoolifyServer[]>("/servers")) ?? [];
    const apps = (await this.client.get<CoolifyHealthRow[]>("/applications")) ?? [];
    const databases = (await this.client.get<CoolifyHealthRow[]>("/databases")) ?? [];
    let services: CoolifyHealthRow[] = [];
    try {
      services = (await this.client.get<CoolifyHealthRow[]>("/services")) ?? [];
    } catch {
      services = []; // like discover(): a team without service access still has a baseline of its apps and databases
    }
    const serverOf = new Map<string, string>();
    await mapLimit(servers, DISCOVER_CONCURRENCY, async (s) => {
      try {
        const resources = (await this.client.get<Array<{ uuid?: string }>>(`/servers/${s.uuid}/resources`)) ?? [];
        for (const r of resources) if (r?.uuid && !serverOf.has(r.uuid)) serverOf.set(r.uuid, s.uuid);
      } catch {
        /* the resource stays without a serverRef */
      }
    });
    return [...coolifyHealthRows("app", apps, serverOf), ...coolifyHealthRows("database", databases, serverOf), ...coolifyHealthRows("service", services, serverOf)];
  }

  async discover(): Promise<ForeignFleet> {
    const warnings: string[] = [];
    // A GET that degrades to a fallback AND records a warning, so a partial 403/404 during enumeration is
    // visible in the plan instead of silently yielding an incomplete fleet.
    const tryGet = async <T>(path: string, fallback: T, label: string): Promise<T> => {
      try {
        const r = await this.client.get<T>(path);
        return (r ?? fallback) as T;
      } catch {
        warnings.push(`could not read ${label} — the import plan may be incomplete`);
        return fallback;
      }
    };

    // Core fleet: a failure here is a real error (bad token / wrong URL) — let it throw so the caller knows.
    const listed = (await this.client.get<CoolifyServer[]>("/servers")) ?? [];
    // The list rows do not carry the unreachable counter or the specs (OS) a run's PREFLIGHT classifies a host by: those are on the
    // single-server read. A server whose detail cannot be read keeps its list row, and the plan says so.
    let detailFailed = 0;
    const servers = await mapLimit(listed, DISCOVER_CONCURRENCY, async (s) => {
      try {
        return withServerDetail(s, await this.client.get<CoolifyServer>(`/servers/${s.uuid}`));
      } catch {
        detailFailed += 1;
        return s;
      }
    });
    if (detailFailed > 0) warnings.push(`could not read the details of ${detailFailed} server(s) — their reachability and OS checks are skipped`);
    const listedApps = (await this.client.get<CoolifyApp[]>("/applications")) ?? [];
    const databases = (await this.client.get<CoolifyDatabase[]>("/databases")) ?? [];
    const serviceList = await tryGet<CoolifyService[]>("/services", [], "services");

    // Enrichment is one GET per resource. A large Coolify fleet is hundreds of calls; doing them
    // SEQUENTIALLY overran the request timeout (the import showed "Reading the fleet…" then failed with a
    // socket reset). Run them with bounded concurrency instead. Each call still degrades to a warning
    // rather than aborting, and the shared maps are keyed by uuid so concurrent writes never collide.
    const resourcesByServer: Record<string, string[]> = {};
    const envsByResource: Record<string, CoolifyEnv[]> = {};
    const envReportByResource: Record<string, NonNullable<ForeignFleet["apps"][number]["envReport"]>> = {};
    const volumesByResource: Record<string, CoolifyVolume[]> = {};

    await mapLimit(servers, DISCOVER_CONCURRENCY, async (s) => {
      const resources = await tryGet<Array<{ uuid?: string }>>(`/servers/${s.uuid}/resources`, [], `resources for server ${s.name ?? s.uuid}`);
      resourcesByServer[s.uuid] = resources.map((r) => r?.uuid).filter((u): u is string => !!u);
    });

    // Coolify 4.1.2's /services list rows carried the members (applications[], databases[]) and the raw compose; from 4.7 they
    // carry neither (the compose is read:sensitive-gated), so the per-service detail GET (it loads the members) is the normal
    // path and the list row is kept only when it already has both. Preserve order.
    const services = await mapLimit(serviceList, DISCOVER_CONCURRENCY, (s) =>
      Array.isArray(s.applications) && typeof s.docker_compose_raw === "string"
        ? Promise.resolve(s)
        : tryGet<CoolifyService>(`/services/${s.uuid}`, s, `service ${s.name ?? s.uuid}`),
    );

    const apps = await mapLimit(listedApps, DISCOVER_CONCURRENCY, async (a) => {
      // The per-app reads are independent → fetch them together. The env read is NOT routed through tryGet: a
      // failure must leave `envReport` ABSENT (never an empty, "clean" report) and say so with a fixed warning.
      const readEnvs = async (): Promise<unknown | undefined> => {
        try {
          return (await this.client.get<unknown>(`/applications/${a.uuid}/envs`)) ?? [];
        } catch {
          warnings.push(`env: could not read variables for ${a.name ?? a.uuid}`);
          return undefined;
        }
      };
      const [envs, vols] = await Promise.all([readEnvs(), tryGet<unknown>(`/applications/${a.uuid}/storages`, [], `storage for ${a.name ?? a.uuid}`)]);
      // After the two parallel reads, so a worker never has more than the two in flight (the Coolify API is rate limited).
      const withSettings = await this.readAppSettings(a, warnings);
      envsByResource[a.uuid] = extractEnvs(envs ?? []);
      // Key NAMES + reason codes only (values are inspected in memory by the classifier and dropped at once).
      if (envs !== undefined) envReportByResource[a.uuid] = buildEnvReport(envs);
      volumesByResource[a.uuid] = extractVolumes(vols);
      return withSettings;
    });

    // Scheduled database backups (read-only GET per database; Redis-family engines have none in Coolify) and the S3 storages that name their
    // targets. A failed backup read is counted in ONE warning (an unread schedule would otherwise look like "no backup"); the S3 list is
    // optional (a limited token gets a 403): without it a target is simply not named. Only names are kept, never an S3 key or secret.
    const backupsByResource: Record<string, CoolifyBackup[]> = {};
    let backupsFailed = 0;
    await mapLimit(databases, DISCOVER_CONCURRENCY, async (d) => {
      volumesByResource[d.uuid] = extractVolumes(await tryGet<unknown>(`/databases/${d.uuid}/storages`, [], `storage for ${d.name ?? d.uuid}`));
      if (BACKUP_LESS_ENGINES.has(coolifyEngine(d))) return;
      try {
        const rows = await this.client.get<unknown>(`/databases/${encodeURIComponent(d.uuid)}/backups`);
        if (Array.isArray(rows) && rows.length) backupsByResource[d.uuid] = rows.map(pickBackup);
      } catch (e) {
        if (!isNotFound(e)) backupsFailed += 1; // a Coolify without the endpoint has no scheduled backups to show
      }
    });
    if (backupsFailed > 0) warnings.push(`could not read the scheduled backups of ${backupsFailed} database(s) — a backup schedule they have is not shown in the plan`);
    let s3Storages: CoolifyS3Storage[] = [];
    if (Object.keys(backupsByResource).length > 0) {
      try {
        const rows = await this.client.get<unknown>("/s3-storages");
        s3Storages = Array.isArray(rows) ? rows.map(pickS3Storage) : [];
      } catch {
        s3Storages = [];
      }
    }

    // Read the project tree before the fleet is built so an unreadable /projects lands in the plan's warnings.
    const tree = await this.readProjectTree([...listedApps, ...databases], tryGet);
    const fleet = buildCoolifyFleet({ servers, resourcesByServer, apps, databases, services, envsByResource, envReportByResource, volumesByResource, backupsByResource, s3Storages, warnings });
    return tree ? placeInTree(fleet, tree) : fleet;
  }

  /**
   * Mirror Coolify's project → environment tree, like the Dokploy import does: the review then places every app and
   * database in a Tugra project/environment named after its Coolify one (IsBulKibris / production) instead of the
   * team default. Coolify rows carry `environment_id`; `/projects/{uuid}` lists each project's environments by id.
   * Best effort: an unreadable project tree only leaves resources in the team default (and says so).
   */
  private async readProjectTree(
    rows: Array<{ uuid?: string; environment_id?: number | string | null }>,
    tryGet: <T>(path: string, fallback: T, label: string) => Promise<T>,
  ): Promise<ProjectTree | undefined> {
    const list = await tryGet<Array<{ uuid?: string; name?: string; description?: string | null }>>("/projects", [], "projects");
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const details = await mapLimit(list.filter((p) => typeof p?.uuid === "string" && p.uuid), DISCOVER_CONCURRENCY, (p) =>
      tryGet<{ uuid?: string; name?: string; description?: string | null; environments?: Array<{ id?: number | string; name?: string }> }>(
        `/projects/${encodeURIComponent(p.uuid as string)}`,
        p,
        `project ${p.name ?? p.uuid}`,
      ),
    );
    const projects: ForeignProject[] = [];
    const locByEnvId = new Map<string, { projectRef: string; environmentRef: string }>();
    for (const d of details) {
      if (!d?.uuid || !d.name) continue;
      const envRows = (Array.isArray(d.environments) ? d.environments : []).filter(
        (e) => e && e.id !== undefined && e.id !== null && typeof e.name === "string" && e.name,
      );
      // Exactly one default per project: "production" when present, else the first environment.
      const defaultIdx = Math.max(0, envRows.findIndex((e) => e.name === "production"));
      const environments = envRows.map((e, i) => ({ ref: `${d.uuid}#${String(e.id)}`, name: e.name as string, isDefault: i === defaultIdx }));
      projects.push({ ref: d.uuid, name: d.name, description: d.description ?? undefined, tags: [], environments });
      for (const e of environments) locByEnvId.set(e.ref.slice(d.uuid.length + 1), { projectRef: d.uuid, environmentRef: e.ref });
    }
    if (projects.length === 0) return undefined;
    const locByUuid = new Map<string, { projectRef: string; environmentRef: string }>();
    for (const r of rows) {
      if (!r?.uuid || r.environment_id === undefined || r.environment_id === null) continue;
      const loc = locByEnvId.get(String(r.environment_id));
      if (loc) locByUuid.set(r.uuid, loc);
    }
    return { projects, locByUuid };
  }

  /**
   * The `application_settings` of an app, from ONE detail GET: `is_static` / `is_spa` of a nixpacks / railpack / static app and the
   * custom container name prefix of ANY app. Since Coolify 4.7 they are `application_settings` columns and appear only as `settings.*`
   * on the single-application read (the list rows do not load the settings), so an app takes the GET when it still needs one of them;
   * older versions kept the static flags on the row and have no prefix (the row is returned unchanged when it has what it needs).
   * A failed read keeps the list row and says so: a static site would otherwise be planned as a started process, and an app with a
   * custom prefix would be looked for under its uuid on the source host, silently.
   */
  private async readAppSettings(a: CoolifyApp, warnings: string[]): Promise<CoolifyApp> {
    const known = appStaticFlags(a);
    const needsStatic = coolifyNeedsSettings(a) && (known.isStatic === undefined || known.isSpa === undefined);
    const needsPrefix = !containerPrefixKnown(a);
    if (!needsStatic && !needsPrefix) return a;
    try {
      const detail = await this.client.get<CoolifyApp>(`/applications/${encodeURIComponent(a.uuid)}`);
      if (!detail || typeof detail !== "object" || Array.isArray(detail) || !detail.settings || typeof detail.settings !== "object") return a;
      return {
        ...a,
        settings: { is_static: detail.settings.is_static, is_spa: detail.settings.is_spa, custom_container_name_prefix: detail.settings.custom_container_name_prefix ?? null },
      };
    } catch {
      if (needsStatic) warnings.push(`could not read the static-site settings of ${a.name ?? a.uuid} — a static site may be planned as a regular build`);
      if (needsPrefix) warnings.push(`could not read the container name settings of ${a.name ?? a.uuid} — if it has a custom container name prefix, its container may not be found by name`);
      return a;
    }
  }

  /**
   * Resolve one application's REAL environment values at apply time (requires a read:sensitive token). Coolify
   * returns `value` (+ `real_value`, with shared/magic {{refs}} already expanded) only to a sensitive token;
   * otherwise those fields are absent and the key is reported `unresolved` (with a reason code) so the CALLER can
   * fail loud rather than deploy with a missing value: this method only reports, the executor enforces (strict
   * for Coolify — unacknowledged unresolved/invalid keys fail the task before the app row is created). Preview
   * twins are skipped and counted in `previewSkipped`. Classification is shared with discover's `envReport`
   * ({@link classifyEnvRow}). These values are consumed SERVER-SIDE only — never returned to the client.
   */
  async fetchSecrets(ref: string): Promise<FetchedSecrets> {
    const raw = await this.client.get<unknown>(`/applications/${ref}/envs`);
    const envs = Array.isArray(raw) ? (raw as CoolifyEnv[]) : [];
    const values: Record<string, string> = Object.create(null); // null-proto: a key like "__proto__" is a real entry, not the setter
    const unresolved: ForeignEnv[] = [];
    const invalidKeys: string[] = [];
    let previewSkipped = 0;
    const flags: NonNullable<FetchedSecrets["flags"]> = Object.create(null);
    for (const e of envs) {
      const c = classifyEnvRow(e);
      if (c.kind === "skip") continue;
      if (c.kind === "preview") {
        previewSkipped++;
        continue;
      }
      if (c.kind === "invalid") {
        invalidKeys.push(c.key);
        continue;
      }
      if (c.kind === "value") {
        values[c.key] = c.value;
        // The four per-variable flags Coolify records on the same row (field names per Coolify's env API schema).
        const f: { buildTime?: boolean; runtime?: boolean; literal?: boolean; multiline?: boolean } = {};
        if (typeof e.is_buildtime === "boolean") f.buildTime = e.is_buildtime;
        if (typeof e.is_runtime === "boolean") f.runtime = e.is_runtime;
        if (typeof e.is_literal === "boolean") f.literal = e.is_literal;
        if (typeof e.is_multiline === "boolean") f.multiline = e.is_multiline;
        if (Object.keys(f).length) flags[c.key] = f;
      } else {
        unresolved.push({ key: c.key, secret: true, reason: c.reason, ref: c.reason === "SHARED_UNEXPANDED" ? { type: "shared" } : c.reason === "MAGIC" ? { type: "magic" } : undefined });
      }
    }
    return { values, unresolved, ...(invalidKeys.length ? { invalidKeys } : {}), ...(previewSkipped ? { previewSkipped } : {}), ...(Object.keys(flags).length ? { flags } : {}) };
  }

  /**
   * Resolve one SERVICE's env values + config-file contents at apply/preview time (requires a read:sensitive token).
   * Same rules as {@link fetchSecrets} (preview twins skipped, `real_value ?? value`, null-prototype maps), plus: the
   * `SERVICE_URL_*` / `SERVICE_FQDN_*` bookkeeping rows are dropped (the importer derives domains itself) and so is any
   * other `is_coolify` row, EXCEPT the carried magic secrets (`SERVICE_PASSWORD_*` / `SERVICE_USER_*` / `SERVICE_BASE64_*` /
   * `SERVICE_REALBASE64_*`: carried, never regenerated). `/services/{uuid}/envs` and `/storages` are UNVERIFIED against live
   * Coolify (probe C0 not approved): a 403/404 returns `undefined`; any other error is re-thrown with a FIXED message,
   * because a client error can echo the response body (which carries the secrets).
   */
  async fetchServiceBundle(ref: string): Promise<ServiceBundle | undefined> {
    let rawEnvs: unknown;
    try {
      rawEnvs = await this.client.get<unknown>(`/services/${encodeURIComponent(ref)}/envs`);
    } catch (e) {
      if (isDeniedOrMissing(e)) return undefined;
      throw new Error(SERVICE_BUNDLE_ERROR);
    }
    const envs = Array.isArray(rawEnvs) ? (rawEnvs as CoolifyEnv[]) : [];
    const values: Record<string, string> = Object.create(null);
    const unresolved: string[] = [];
    const flags: NonNullable<ServiceBundle["flags"]> = Object.create(null);
    for (const e of envs) {
      if (!e || typeof e.key !== "string" || e.is_preview === true) continue;
      if (/^SERVICE_(URL|FQDN)_/.test(e.key)) continue;
      if (e.is_coolify === true && !CARRIED_MAGIC_RE.test(e.key)) continue;
      const v = e.real_value ?? e.value;
      if (typeof v !== "string") {
        unresolved.push(e.key);
        continue;
      }
      values[e.key] = v;
      const f: { buildTime?: boolean; runtime?: boolean; literal?: boolean; multiline?: boolean } = {};
      if (typeof e.is_buildtime === "boolean") f.buildTime = e.is_buildtime;
      if (typeof e.is_runtime === "boolean") f.runtime = e.is_runtime;
      if (typeof e.is_literal === "boolean") f.literal = e.is_literal;
      if (typeof e.is_multiline === "boolean") f.multiline = e.is_multiline;
      if (Object.keys(f).length) flags[e.key] = f;
    }
    let files: ServiceBundle["files"];
    try {
      files = extractServiceFiles(await this.client.get<unknown>(`/services/${encodeURIComponent(ref)}/storages`));
    } catch (e) {
      if (!isDeniedOrMissing(e)) throw new Error(SERVICE_BUNDLE_ERROR);
    }
    return { values, unresolved: unresolved.sort(), ...(Object.keys(flags).length ? { flags } : {}), ...(files?.length ? { files } : {}) };
  }

  /**
   * Re-read one application's container labels and inline Dockerfile text at apply time (both `read:sensitive`-gated
   * on Coolify; absent for a plain token → nothing carried). ONE guarded GET; a transport/permission error PROPAGATES
   * (the executor turns it into a fixed unmapped note). The text lives in memory only — never in the fleet, plan or
   * task output. Compose apps are never queried (the executor does not call this for them).
   */
  async fetchAppExtras(ref: string): Promise<SourceAppExtras | undefined> {
    const row = await this.client.get<unknown>(`/applications/${encodeURIComponent(ref)}`);
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const r = row as CoolifyApp;
    const out: SourceAppExtras = { unmapped: [] };
    const labels = decodeCoolifyLabels(r.custom_labels);
    if (labels === "unparsable") out.unmapped.push({ field: "customLabels", ...why("labels_unparsable") });
    else if (labels.length) out.labels = labels;
    if (r.build_pack === "dockerfile") {
      const dockerfile = decodeCoolifyDockerfile(nonEmptyStr(r.dockerfile) ?? r.dockerfile_raw);
      if (dockerfile !== undefined) out.dockerfile = dockerfile;
    }
    return out;
  }

  async close(): Promise<void> {}
}

/** The ONLY error text a failed service-bundle read may surface (a client error can echo the response body = secrets). */
export const SERVICE_BUNDLE_ERROR = "service variables could not be read";
const CARRIED_MAGIC_RE = /^SERVICE_(PASSWORD|USER|BASE64|REALBASE64)_/;

/** A 401/403/404 from the Coolify client (the token cannot read it / the endpoint does not exist). The concrete client
 *  throws an error carrying the HTTP status; a status-less error is treated as a hard failure. */
function isDeniedOrMissing(e: unknown): boolean {
  const status = (e as { status?: unknown; statusCode?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode;
  if (status === 401 || status === 403 || status === 404) return true;
  return typeof e === "object" && e !== null && /\b(401|403|404)\b/.test(String((e as { message?: unknown }).message ?? ""));
}

function isNotFound(e: unknown): boolean {
  const status = (e as { status?: unknown; statusCode?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode;
  return status === 404 || (typeof e === "object" && e !== null && /\b404\b/.test(String((e as { message?: unknown }).message ?? "")));
}

/** Pure: Coolify's `/storages` file rows (`file_storages`: fs_path/content/is_directory) → relative config files. Only
 *  rows with real text content are kept; the compose transform later accepts only paths its raw compose declares. */
function extractServiceFiles(raw: unknown): ServiceBundle["files"] {
  const obj = (raw ?? {}) as { file_storages?: unknown };
  const rows = Array.isArray(obj.file_storages) ? (obj.file_storages as Array<Record<string, unknown>>) : [];
  const out: NonNullable<ServiceBundle["files"]> = [];
  for (const r of rows) {
    if (!r || r.is_directory === true) continue;
    const fsPath = typeof r.fs_path === "string" ? r.fs_path : undefined;
    const content = typeof r.content === "string" ? r.content : undefined;
    if (!fsPath || content === undefined) continue;
    // Coolify stores the service's files under /data/coolify/services/<uuid>/<relative path>: keep the relative tail.
    const rel = fsPath.replace(/^\/data\/coolify\/services\/[^/]+\//, "");
    out.push({ path: rel.replace(/^\.\//, ""), content });
  }
  return out;
}

/** The value when it is a non-empty string, else undefined (so `??` falls through an empty `dockerfile` to `dockerfile_raw`). */
const nonEmptyStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** Engines Coolify has no scheduled database backup for (so no read is made). */
const BACKUP_LESS_ENGINES = new Set(["REDIS", "KEYDB", "DRAGONFLY"]);

/** Pure: copy ONLY the non-secret fields of a backup row (an S3 key or secret must never ride along). */
function pickBackup(raw: unknown): CoolifyBackup {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s3 = r.s3 && typeof r.s3 === "object" ? (r.s3 as Record<string, unknown>) : undefined;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : undefined,
    save_s3: typeof r.save_s3 === "boolean" ? r.save_s3 : undefined,
    frequency: typeof r.frequency === "string" ? r.frequency : undefined,
    s3_storage_id: typeof r.s3_storage_id === "number" || typeof r.s3_storage_id === "string" ? r.s3_storage_id : undefined,
    s3_storage_uuid: typeof r.s3_storage_uuid === "string" ? r.s3_storage_uuid : undefined,
    ...(typeof s3?.name === "string" ? { s3: { name: s3.name } } : {}),
  };
}

/** Pure: copy ONLY the identity of an S3 storage row (never its key or secret). */
function pickS3Storage(raw: unknown): CoolifyS3Storage {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof r.id === "number" || typeof r.id === "string" ? r.id : undefined,
    uuid: typeof r.uuid === "string" ? r.uuid : undefined,
    name: typeof r.name === "string" ? r.name : undefined,
  };
}

/** Max concurrent enrichment GETs during discover — fast enough for a large fleet without hammering Coolify. */
const DISCOVER_CONCURRENCY = 8;

// mapLimit moved to ./map-limit (shared by every source adapter). Re-exported here so existing importers
// (coolify.source.spec) keep resolving it from this module.
export { mapLimit };

/** Pure: Coolify's /envs list merges production + preview-deployment twins; keep only real (key'd, non-preview) rows. */
function extractEnvs(raw: unknown): CoolifyEnv[] {
  return Array.isArray(raw) ? (raw as CoolifyEnv[]).filter((e) => e && typeof e.key === "string" && e.is_preview !== true) : [];
}

/** Pure: Coolify's /storages returns `{persistent_storages, file_storages}`; take the persistent volumes. */
function extractVolumes(raw: unknown): CoolifyVolume[] {
  if (Array.isArray(raw)) return raw as CoolifyVolume[];
  const obj = (raw ?? {}) as { persistent_storages?: unknown; persistent?: unknown; data?: unknown };
  const arr = obj.persistent_storages ?? obj.persistent ?? obj.data ?? [];
  return Array.isArray(arr) ? (arr as CoolifyVolume[]) : [];
}

/** Coolify's project tree: the projects (with environments) and where each app/database (by uuid) lives. */
interface ProjectTree {
  projects: ForeignProject[];
  locByUuid: Map<string, { projectRef: string; environmentRef: string }>;
}

/** Attach the tree to a built fleet: each app and database gets its source project/environment refs. */
function placeInTree(fleet: ForeignFleet, tree: ProjectTree): ForeignFleet {
  const place = <T extends { sourceRef: string; projectRef?: string; environmentRef?: string }>(x: T): T => {
    const loc = tree.locByUuid.get(x.sourceRef);
    return loc && !x.projectRef ? { ...x, ...loc } : x;
  };
  return { ...fleet, apps: fleet.apps.map(place), databases: fleet.databases.map(place), projects: tree.projects };
}
