import type { ForeignFleet } from "../foreign-fleet";
import type { ImportSource, ImportSourceCapabilities, FetchedSecrets } from "../import-source";
import { mapLimit } from "./map-limit";
import {
  buildDokployFleet,
  parseDotenv,
  type DokployApplication,
  type DokployCompose,
  type DokployDatabase,
  type DokployEngineTable,
  type DokployServer,
} from "./dokploy-map";

/**
 * A minimal authenticated GET client for one Dokploy instance. The concrete implementation (base URL +
 * `x-api-key` header + the SSRF-guarded fetch) is {@link DokployHttpClient}; the adapter stays
 * transport-agnostic and unit-testable with a fake. Dokploy's REST API lives under `/api` as
 * `/<router>.<procedure>` (queries are GET with query-string params).
 */
export interface DokployClient {
  get<T>(path: string): Promise<T>;
}

/** Max concurrent detail GETs during discover — Dokploy's project.all is slim, so a fleet is N+1 `*.one`. */
const DISCOVER_CONCURRENCY = 4;
const enc = encodeURIComponent;

/** The six database engine tables, with their id column and `.one` endpoint. */
const DB_TABLES: Array<{ table: DokployEngineTable; idKey: string; one: (id: string) => string }> = [
  { table: "postgres", idKey: "postgresId", one: (id) => `/postgres.one?postgresId=${enc(id)}` },
  { table: "mysql", idKey: "mysqlId", one: (id) => `/mysql.one?mysqlId=${enc(id)}` },
  { table: "mariadb", idKey: "mariadbId", one: (id) => `/mariadb.one?mariadbId=${enc(id)}` },
  { table: "mongo", idKey: "mongoId", one: (id) => `/mongo.one?mongoId=${enc(id)}` },
  { table: "redis", idKey: "redisId", one: (id) => `/redis.one?redisId=${enc(id)}` },
  { table: "libsql", idKey: "libsqlId", one: (id) => `/libsql.one?libsqlId=${enc(id)}` },
];

/** A slim node from project.all — a project or an environment carrying stub service arrays + its env blob. */
interface DokployTreeNode {
  projectId?: string;
  environmentId?: string;
  name?: string | null;
  env?: string | null;
  environments?: DokployTreeNode[] | null;
  applications?: Array<{ applicationId?: string } | null> | null;
  compose?: Array<{ composeId?: string } | null> | null;
  postgres?: Array<Record<string, unknown> | null> | null;
  mysql?: Array<Record<string, unknown> | null> | null;
  mariadb?: Array<Record<string, unknown> | null> | null;
  mongo?: Array<Record<string, unknown> | null> | null;
  redis?: Array<Record<string, unknown> | null> | null;
  libsql?: Array<Record<string, unknown> | null> | null;
}

/** What `fetchSecrets` needs to re-locate a resource's detail endpoint from its appName (sourceRef). */
type SecretRefTarget =
  | { kind: "application"; id: string }
  | { kind: "compose"; id: string }
  | { kind: "database"; table: DokployEngineTable; id: string };

/**
 * The `dokploy` import source (read-only discover). Enumerates a Dokploy fleet over its tRPC-OpenAPI REST API
 * (header `x-api-key`) and maps it to a SECRET-FREE {@link ForeignFleet}.
 *
 * Unlike Coolify, Dokploy returns env VALUES + DB passwords in plaintext in the same detail response as the
 * config, so the mapper (dokploy-map.ts) carries KEYS + non-secret identity only. Secret VALUES are parsed
 * server-side in {@link fetchSecrets} and never returned to the client. discover() builds an appName→detail
 * cache so fetchSecrets can re-locate a resource without re-walking the whole tree.
 */
export class DokploySource implements ImportSource {
  readonly kind = "dokploy" as const;
  /** appName (sourceRef) → the detail endpoint target, populated during discover(). */
  private readonly refIndex = new Map<string, SecretRefTarget>();

  constructor(private readonly client: DokployClient) {}

  capabilities(): ImportSourceCapabilities {
    // discover is API-only; moving DB data / volume bytes needs SSH (the Dokploy API has no data egress).
    return { apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false };
  }

  async verify(): Promise<{ ok: boolean; version?: string; detail?: string }> {
    try {
      const projects = await this.client.get<unknown>("/project.all");
      if (!Array.isArray(projects)) return { ok: false, detail: "unexpected response — is the URL a Dokploy API root (…/api)?" };
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "verification failed" };
    }
  }

  async discover(): Promise<ForeignFleet> {
    this.refIndex.clear();
    const warnings: string[] = [];
    const tryGet = async <T>(path: string, fallback: T, label: string): Promise<T> => {
      try {
        const r = await this.client.get<T>(path);
        return (r ?? fallback) as T;
      } catch {
        warnings.push(`could not read ${label} — the import plan may be incomplete`);
        return fallback;
      }
    };

    // Core tree: a failure here is a real error (bad key / wrong URL) — let it throw so the caller knows.
    const projects = (await this.client.get<DokployTreeNode[]>("/project.all")) ?? [];

    const appIds = new Set<string>();
    const composeIds = new Set<string>();
    const dbStubs = new Map<string, { table: DokployEngineTable; id: string }>(); // id → stub (dedupe)
    const sharedEnvBlobs: Array<{ scope: "project" | "environment"; blob?: string | null }> = [];

    for (const project of projects) {
      if (project.env) sharedEnvBlobs.push({ scope: "project", blob: project.env });
      const envNodes = project.environments ?? [];
      for (const envNode of envNodes) if (envNode?.env) sharedEnvBlobs.push({ scope: "environment", blob: envNode.env });
      // Read service stubs from BOTH the project node (older Dokploy) and each environment node (newer).
      for (const node of [project, ...envNodes]) {
        for (const a of node.applications ?? []) if (a?.applicationId) appIds.add(a.applicationId);
        for (const c of node.compose ?? []) if (c?.composeId) composeIds.add(c.composeId);
        for (const t of DB_TABLES) {
          for (const d of (node[t.table] ?? []) as Array<Record<string, unknown> | null>) {
            const id = d?.[t.idKey];
            if (typeof id === "string" && id) dbStubs.set(id, { table: t.table, id });
          }
        }
      }
    }

    // Detail fan-out (bounded concurrency; a per-resource failure degrades to a warning, like CoolifySource).
    const appDetails = (
      await mapLimit([...appIds], DISCOVER_CONCURRENCY, (id) => tryGet<DokployApplication | null>(`/application.one?applicationId=${enc(id)}`, null, `application ${id}`))
    ).filter((a): a is DokployApplication => !!a && !!a.appName);
    for (const a of appDetails) this.refIndex.set(a.appName, { kind: "application", id: a.applicationId });

    const composeDetails = (
      await mapLimit([...composeIds], DISCOVER_CONCURRENCY, (id) => tryGet<DokployCompose | null>(`/compose.one?composeId=${enc(id)}`, null, `compose ${id}`))
    ).filter((c): c is DokployCompose => !!c && !!c.appName);
    for (const c of composeDetails) this.refIndex.set(c.appName, { kind: "compose", id: c.composeId });

    const dbResults = await mapLimit([...dbStubs.values()], DISCOVER_CONCURRENCY, async (stub) => {
      const def = DB_TABLES.find((t) => t.table === stub.table)!;
      const detail = await tryGet<DokployDatabase | null>(def.one(stub.id), null, `${stub.table} ${stub.id}`);
      if (!detail || !detail.appName) return null;
      return { detail, engineTable: stub.table, serverRef: detail.serverId ?? undefined, id: stub.id };
    });
    const dbDetails = dbResults.filter((d): d is NonNullable<typeof d> => d !== null);
    for (const d of dbDetails) this.refIndex.set(d.detail.appName, { kind: "database", table: d.engineTable, id: d.id });

    const servers = await tryGet<DokployServer[]>("/server.all", [], "servers");

    return buildDokployFleet({
      servers: Array.isArray(servers) ? servers : [],
      apps: appDetails.map((detail) => ({ detail, serverRef: detail.serverId ?? undefined })),
      composes: composeDetails.map((detail) => ({ detail, serverRef: detail.serverId ?? undefined })),
      databases: dbDetails.map(({ detail, engineTable, serverRef }) => ({ detail, engineTable, serverRef })),
      sharedEnvBlobs,
      warnings,
    });
  }

  /**
   * Resolve one resource's REAL env values at apply time (server-side only — never returned to the client).
   * Keyed by `sourceRef` = appName. S1 returns plain (non-reference) values and reports every `${{…}}`,
   * vault or `enc:v1:` value as `unresolved` so the executor fails loud rather than deploying a literal
   * reference string. Full cross-scope `${{project/environment/self}}` EXPANSION is slice S2.
   */
  async fetchSecrets(ref: string): Promise<FetchedSecrets> {
    let target = this.refIndex.get(ref);
    if (!target) {
      // Cold path (e.g. a new service process that did not run discover): rebuild the index once.
      await this.discover().catch(() => undefined);
      target = this.refIndex.get(ref);
    }
    const values: Record<string, string> = Object.create(null); // null-proto: a key like "__proto__" is a real entry
    const unresolved: FetchedSecrets["unresolved"] = [];
    if (!target) return { values, unresolved };

    const path =
      target.kind === "application"
        ? `/application.one?applicationId=${enc(target.id)}`
        : target.kind === "compose"
          ? `/compose.one?composeId=${enc(target.id)}`
          : DB_TABLES.find((t) => t.table === target!.table)!.one(target.id);

    let detail: { env?: string | null; buildArgs?: string | null } | null = null;
    try {
      detail = await this.client.get<{ env?: string | null; buildArgs?: string | null }>(path);
    } catch {
      return { values, unresolved };
    }

    for (const blob of [detail?.env, detail?.buildArgs]) {
      for (const { key, value } of parseDotenv(blob)) {
        const isRef = /\$\{\{/.test(value) || value.startsWith("enc:v1:");
        if (isRef) {
          const type = /\$\{\{\s*vault\./i.test(value) ? "vault" : value.startsWith("enc:v1:") ? "encrypted" : "shared";
          unresolved.push({ key, secret: true, ref: { type } });
        } else {
          values[key] = value;
        }
      }
    }
    return { values, unresolved };
  }

  async close(): Promise<void> {}
}
