import { GuardedHttpGet, type RawTransport } from "../importer/sources/guarded-get";
import type { BeszelAlert, BeszelStatsRecord, BeszelSystem } from "./beszel-map";

/** What one read of a Beszel hub yields. Webhooks/emails come from every `user_settings` row the login can see. */
export interface BeszelSnapshot {
  systems: BeszelSystem[];
  alerts: BeszelAlert[];
  webhooks: string[];
  emails: string[];
}

export type BeszelErrorCode = "badCredentials" | "unreachable" | "notBeszel" | "forbidden" | "mfa";
export class BeszelError extends Error {
  constructor(readonly code: BeszelErrorCode, message: string) {
    super(message);
  }
}

const PAGE = 200;
const MAX_PAGES = 25; // 5000 records per collection: far above any real hub, bounds a hostile one

interface PbList<T> {
  items?: T[];
  totalPages?: number;
}
type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Read-only client for a Beszel hub (a PocketBase app). Login is PocketBase's password auth; the token is kept in memory
 * only. Every request goes through the SSRF-pinned guarded transport the other importers use (no redirects, size and
 * time caps), so a typed URL cannot be turned into a request to loopback or cloud metadata.
 */
export class BeszelClient {
  private readonly http: GuardedHttpGet;
  private token = "";

  constructor(baseUrl: string, opts: { transport?: RawTransport } = {}) {
    this.http = new GuardedHttpGet(baseUrl.replace(/\/+$/, ""), {
      apiPrefix: "/api",
      label: "Beszel",
      headers: (): Record<string, string> => (this.token ? { Authorization: this.token } : {}),
      includeApiMessage: true,
      errorHint: (status) => (status === 404 ? " (is this the address of a Beszel hub?)" : ""),
      ...(opts.transport ? { transport: opts.transport } : {}),
    });
  }

  /** Sign in as a Beszel user (falling back to a PocketBase superuser). The password is never echoed in an error. */
  async login(identity: string, password: string): Promise<void> {
    let mfa = false;
    for (const collection of ["users", "_superusers"] as const) {
      try {
        const res = await this.http.postJson<{ token?: string }>(`/collections/${collection}/auth-with-password`, { identity, password });
        if (typeof res?.token === "string" && res.token) {
          this.token = res.token;
          return;
        }
        throw new BeszelError("notBeszel", "the address did not answer like a Beszel hub");
      } catch (e) {
        if (e instanceof BeszelError) throw e;
        const msg = e instanceof Error ? e.message : "";
        const status = /API error (\d{3})/.exec(msg)?.[1];
        if (/mfa/i.test(msg)) mfa = true;
        if (collection === "users" && status === "404") throw new BeszelError("notBeszel", "the address did not answer like a Beszel hub");
        if (status === "400" || status === "401" || status === "403" || status === "404") continue; // not accepted here: try the next collection
        throw new BeszelError("unreachable", this.scrub(msg, password) || "could not reach Beszel");
      }
    }
    if (mfa) throw new BeszelError("mfa", "this account needs a second factor, which the import cannot answer");
    throw new BeszelError("badCredentials", "Beszel did not accept these credentials");
  }

  private scrub(text: string, secret: string): string {
    return secret ? text.split(secret).join("***") : text;
  }

  private async all<T extends Rec>(collection: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({ page: String(page), perPage: String(PAGE), skipTotal: "false", ...params });
      let res: PbList<T>;
      try {
        res = await this.http.get<PbList<T>>(`/collections/${collection}/records?${qs.toString()}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "request failed";
        if (/API error 40[13]/.test(msg)) throw new BeszelError("forbidden", `this account cannot read ${collection}`);
        throw new BeszelError("unreachable", msg);
      }
      out.push(...(res.items ?? []));
      if (page >= (res.totalPages ?? 1) || (res.items ?? []).length < PAGE) break;
    }
    return out;
  }

  async snapshot(): Promise<BeszelSnapshot> {
    const [sys, alerts, settings] = await Promise.all([
      this.all<Rec>("systems", { sort: "name" }),
      this.all<Rec>("alerts"),
      this.all<Rec>("user_settings").catch(() => [] as Rec[]), // notification settings are optional: alerts still import
    ]);
    const webhooks = new Set<string>();
    const emails = new Set<string>();
    for (const row of settings) {
      const s = (row.settings ?? {}) as { webhooks?: unknown; emails?: unknown };
      for (const w of Array.isArray(s.webhooks) ? s.webhooks : []) if (typeof w === "string" && w.trim()) webhooks.add(w.trim());
      for (const e of Array.isArray(s.emails) ? s.emails : []) if (typeof e === "string" && e.trim()) emails.add(e.trim());
    }
    return {
      systems: sys.map((r) => ({ id: str(r.id), name: str(r.name), host: str(r.host), status: str(r.status) })).filter((s) => s.id),
      alerts: alerts
        .map((r) => ({ id: str(r.id), system: str(r.system), name: str(r.name), value: Number(r.value), min: Number(r.min) }))
        .filter((a) => a.id && a.system && a.name),
      webhooks: [...webhooks],
      emails: [...emails],
    };
  }

  /** `system_stats` rows of one system for the given resolutions, oldest first. Bounded: <= ~400 rows per system. */
  async stats(systemId: string, types: readonly string[]): Promise<BeszelStatsRecord[]> {
    if (!/^[a-z0-9]{1,32}$/i.test(systemId)) return []; // a PocketBase id; never interpolate anything else into a filter
    const typeFilter = types.filter((t) => /^\d+m$/.test(t)).map((t) => `type='${t}'`).join(" || ");
    if (!typeFilter) return [];
    const rows = await this.all<Rec>("system_stats", { filter: `system='${systemId}' && (${typeFilter})`, sort: "created", fields: "created,type,stats" });
    return rows
      .map((r) => ({ created: str(r.created), type: str(r.type), stats: (r.stats && typeof r.stats === "object" ? r.stats : {}) as Record<string, unknown> }))
      .filter((r) => r.created && r.type);
  }
}
