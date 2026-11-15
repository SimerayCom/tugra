import type { ForeignEnv, ForeignFleet } from "../foreign-fleet";
import type { ImportSource, ImportSourceCapabilities, FetchedSecrets, SourceAppExtras } from "../import-source";
import { why } from "../reason";
import { mapLimit } from "./map-limit";
import { buildEnvReport, classifyEnvRow } from "../env-report";
import {
  buildCoolifyFleet,
  decodeCoolifyDockerfile,
  decodeCoolifyLabels,
  type CoolifyApp,
  type CoolifyDatabase,
  type CoolifyEnv,
  type CoolifyServer,
  type CoolifyService,
  type CoolifyVolume,
} from "./coolify-map";

/**
 * A minimal authenticated GET client for one Coolify instance. The concrete implementation (base URL +
 * Bearer token + the SSRF-guarded fetch) is supplied by the importer service in S2; the adapter stays
 * transport-agnostic and unit-testable with a fake client.
 */
export interface CoolifyClient {
  get<T>(path: string): Promise<T>;
}

/**
 * The `coolify` import source (read-only discover). Enumerates a Coolify v4 fleet over its REST API and maps
 * it to a SECRET-FREE {@link ForeignFleet}. discover() runs on a plain read token: passwords, env values,
 * internal_db_url and docker_compose_raw are all `read:sensitive`-gated and simply absent — the fleet carries
 * only non-secret identity + a `secretRef` (the Coolify uuid) per resource for a later sensitive-scoped fetch.
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
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "verification failed" };
    }
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
    const servers = (await this.client.get<CoolifyServer[]>("/servers")) ?? [];
    const apps = (await this.client.get<CoolifyApp[]>("/applications")) ?? [];
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

    // GET /services does NOT eager-load member apps/databases; the detail endpoint does. Preserve order.
    const services = await mapLimit(serviceList, DISCOVER_CONCURRENCY, (s) =>
      tryGet<CoolifyService>(`/services/${s.uuid}`, s, `service ${s.name ?? s.uuid}`),
    );

    await mapLimit(apps, DISCOVER_CONCURRENCY, async (a) => {
      // The two per-app reads are independent → fetch them together. The env read is NOT routed through tryGet: a
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
      envsByResource[a.uuid] = extractEnvs(envs ?? []);
      // Key NAMES + reason codes only (values are inspected in memory by the classifier and dropped at once).
      if (envs !== undefined) envReportByResource[a.uuid] = buildEnvReport(envs);
      volumesByResource[a.uuid] = extractVolumes(vols);
    });

    await mapLimit(databases, DISCOVER_CONCURRENCY, async (d) => {
      volumesByResource[d.uuid] = extractVolumes(await tryGet<unknown>(`/databases/${d.uuid}/storages`, [], `storage for ${d.name ?? d.uuid}`));
    });

    return buildCoolifyFleet({ servers, resourcesByServer, apps, databases, services, envsByResource, envReportByResource, volumesByResource, warnings });
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

/** The value when it is a non-empty string, else undefined (so `??` falls through an empty `dockerfile` to `dockerfile_raw`). */
const nonEmptyStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

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
