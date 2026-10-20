import type { ForeignEnv, ForeignFleet } from "../foreign-fleet";
import type { ImportSource, ImportSourceCapabilities, FetchedSecrets } from "../import-source";
import {
  buildCoolifyFleet,
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

    // Enrichment: degrade with a warning rather than aborting the whole discovery.
    const resourcesByServer: Record<string, string[]> = {};
    for (const s of servers) {
      const resources = await tryGet<Array<{ uuid?: string }>>(`/servers/${s.uuid}/resources`, [], `resources for server ${s.name ?? s.uuid}`);
      resourcesByServer[s.uuid] = resources.map((r) => r?.uuid).filter((u): u is string => !!u);
    }

    const serviceList = await tryGet<CoolifyService[]>("/services", [], "services");
    const services: CoolifyService[] = [];
    for (const s of serviceList) {
      // GET /services does NOT eager-load member apps/databases; the detail endpoint does.
      services.push(await tryGet<CoolifyService>(`/services/${s.uuid}`, s, `service ${s.name ?? s.uuid}`));
    }

    const envsByResource: Record<string, CoolifyEnv[]> = {};
    const volumesByResource: Record<string, CoolifyVolume[]> = {};
    for (const a of apps) {
      envsByResource[a.uuid] = extractEnvs(await tryGet<unknown>(`/applications/${a.uuid}/envs`, [], `env for ${a.name ?? a.uuid}`));
      volumesByResource[a.uuid] = extractVolumes(await tryGet<unknown>(`/applications/${a.uuid}/storages`, [], `storage for ${a.name ?? a.uuid}`));
    }
    for (const d of databases) {
      volumesByResource[d.uuid] = extractVolumes(await tryGet<unknown>(`/databases/${d.uuid}/storages`, [], `storage for ${d.name ?? d.uuid}`));
    }

    return buildCoolifyFleet({ servers, resourcesByServer, apps, databases, services, envsByResource, volumesByResource, warnings });
  }

  /**
   * Resolve one application's REAL environment values at apply time (requires a read:sensitive token). Coolify
   * returns `value` (+ `real_value`, with shared/magic {{refs}} already expanded) only to a sensitive token;
   * otherwise those fields are absent and the key is reported `unresolved` so the executor fails loud rather
   * than deploying with a missing value. Preview twins are skipped. These values are consumed SERVER-SIDE
   * only — never returned to the client.
   */
  async fetchSecrets(ref: string): Promise<FetchedSecrets> {
    const raw = await this.client.get<unknown>(`/applications/${ref}/envs`);
    const envs = Array.isArray(raw) ? (raw as CoolifyEnv[]) : [];
    const values: Record<string, string> = Object.create(null); // null-proto: a key like "__proto__" is a real entry, not the setter
    const unresolved: ForeignEnv[] = [];
    for (const e of envs) {
      if (!e || typeof e.key !== "string" || e.is_preview === true) continue;
      const v = e.real_value ?? e.value; // real_value resolves shared/magic references
      if (typeof v === "string") {
        values[e.key] = v;
      } else {
        unresolved.push({ key: e.key, secret: true, ref: e.is_shared ? { type: "shared" } : e.is_coolify ? { type: "magic" } : undefined });
      }
    }
    return { values, unresolved };
  }

  async close(): Promise<void> {}
}

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
