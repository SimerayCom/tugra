import type { ForeignFleet } from "../foreign-fleet";
import type { ImportSource, ImportSourceCapabilities, FetchedSecrets, FetchedDbCredentials, SourceProbe } from "../import-source";
import {
  buildCaproverFleet,
  dbCredentialsFromEnv,
  envPairs,
  isDatabaseApp,
  type CaproverAppDefinition,
} from "./caprover-map";

/**
 * A minimal authenticated GET client for one CapRover instance: `get` returns the `data` of CapRover's answer envelope.
 * The concrete implementation (login token header + the SSRF-guarded fetch) is CaproverHttpClient; the adapter stays
 * transport-agnostic and unit-testable with a fake.
 */
export interface CaproverClient {
  get<T>(path: string): Promise<T>;
}

const DEFINITIONS_PATH = "/v2/user/apps/appDefinitions";

interface DefinitionsData {
  appDefinitions?: unknown;
  rootDomain?: string | null;
}

/**
 * The `caprover` import source (read-only discover). One call lists every app of the instance with its env, volumes,
 * ports, domains and deploy history; the adapter maps that to a SECRET-FREE {@link ForeignFleet}. The raw list (env values,
 * the app's basic-auth password) stays in this instance and is read only by the apply-time secret methods.
 */
export class CaproverSource implements ImportSource {
  readonly kind = "caprover" as const;
  private cache: Promise<CaproverAppDefinition[]> | undefined;
  private rootDomain: string | null | undefined;

  constructor(private readonly client: CaproverClient) {}

  capabilities(): ImportSourceCapabilities {
    // discover is API-only; moving database data and volume bytes needs host access (the CapRover API has no data egress).
    return { apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false };
  }

  private async read(): Promise<CaproverAppDefinition[]> {
    const data = await this.client.get<DefinitionsData | null>(DEFINITIONS_PATH);
    const list = data?.appDefinitions;
    if (!Array.isArray(list)) throw new Error("CapRover returned an unexpected response: use the dashboard address (the /api path is added for you)");
    this.rootDomain = data?.rootDomain;
    return list.filter((d): d is CaproverAppDefinition => !!d && typeof d === "object" && typeof (d as CaproverAppDefinition).appName === "string");
  }

  /** The app list, read once per instance until discover() asks for a fresh one. */
  private definitions(fresh = false): Promise<CaproverAppDefinition[]> {
    if (fresh || !this.cache) {
      const p = this.read();
      this.cache = p;
      p.catch(() => {
        if (this.cache === p) this.cache = undefined; // a failed read is never cached
      });
    }
    return this.cache;
  }

  async verify(): Promise<{ ok: boolean; version?: string; detail?: string }> {
    try {
      await this.definitions(true);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "verification failed" };
    }
  }

  async probe(): Promise<SourceProbe> {
    const defs = await this.definitions();
    const databases = defs.filter(isDatabaseApp).length;
    return { apps: defs.length - databases, databases, services: 0, sensitive: null };
  }

  async discover(): Promise<ForeignFleet> {
    const definitions = await this.definitions(true);
    return buildCaproverFleet({ definitions, rootDomain: this.rootDomain });
  }

  private async find(ref: string): Promise<CaproverAppDefinition | undefined> {
    return (await this.definitions()).find((d) => d.appName === ref);
  }

  /** Resolve one app's REAL env values at apply time (server-side only, never returned to the client). */
  async fetchSecrets(ref: string): Promise<FetchedSecrets> {
    const values: Record<string, string> = Object.create(null); // null-proto: a key like "__proto__" is a real entry
    const def = await this.find(ref);
    if (def) for (const [k, v] of envPairs(def)) values[k] = v;
    return { values, unresolved: [] };
  }

  /** A database app's credentials from its env (server-side only). Undefined when it is not located or sets no password. */
  async fetchDbCredentials(ref: string): Promise<FetchedDbCredentials | undefined> {
    const def = await this.find(ref);
    return def ? dbCredentialsFromEnv(def) : undefined;
  }

  /** The app's HTTP basic-auth user and password (server-side only). Undefined when the app has none or CapRover keeps no readable password. */
  async fetchBasicAuthCredentials(ref: string): Promise<Array<{ user: string; password: string }> | undefined> {
    const def = (await this.find(ref)) as (CaproverAppDefinition & { httpAuth?: { user?: unknown; password?: unknown } | null }) | undefined;
    const auth = def?.httpAuth;
    if (!auth || typeof auth.user !== "string" || !auth.user || typeof auth.password !== "string" || !auth.password) return undefined;
    return [{ user: auth.user, password: auth.password }];
  }

  async close(): Promise<void> {
    this.cache = undefined;
  }
}
