/** A row from a list endpoint (we render a subset of columns; the full object flows through `--json`). */
export type Row = Record<string, unknown>;

/** The hub's public version descriptor (GET /version). */
export interface HubVersion {
  version: string;
  protocol: number;
  channel: string;
  commit: string;
  edition: string;
}

/** An error carrying the hub's HTTP status + message. status 0 = the hub was unreachable. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function joinMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) return m.filter((x) => typeof x === "string").join("; ");
  }
  return fallback;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A thin, hand-written client over the hub's public REST API, authenticated with a personal access token. */
export class TugraClient {
  private readonly base: string;

  constructor(
    private readonly opts: { hub: string; token: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // Normalize: drop a trailing slash so `${base}/api/v1` never double-slashes.
    this.base = opts.hub.replace(/\/+$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}/api/v1${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, `cannot reach ${this.base}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, joinMessage(parsed, res.statusText || `HTTP ${res.status}`));
    return parsed as T;
  }

  /** Generic authenticated request to any API path (the `tugra api` passthrough). The caller may include or
   *  omit the `/api/v1` prefix and a leading slash; the query string is preserved. */
  requestRaw<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let p = path.startsWith("/") ? path : `/${path}`;
    p = p.replace(/^\/api\/v1(?=[/?]|$)/, ""); // tolerate an included /api/v1 prefix
    if (!p.startsWith("/")) p = `/${p}`;
    return this.request<T>(method.toUpperCase(), p, body);
  }

  listServers(): Promise<Row[]> {
    return this.request("GET", "/servers");
  }
  listApps(): Promise<Row[]> {
    return this.request("GET", "/apps");
  }
  deployApp(id: string): Promise<Row> {
    return this.request("POST", `/apps/${encodeURIComponent(id)}/deploy`, {});
  }
  restartApp(id: string): Promise<Row> {
    return this.request("POST", `/apps/${encodeURIComponent(id)}/restart`);
  }
  autoSetupDomain(
    id: string,
    input: { domain: string; credentialId?: string; includeWww?: boolean; overwrite?: boolean; dryRun?: boolean },
  ): Promise<Row> {
    return this.request("POST", `/apps/${encodeURIComponent(id)}/domain/auto-setup`, input);
  }
  appLogs(id: string, tail?: number): Promise<unknown> {
    // Only forward a sane positive line count; a NaN (bad --tail) or 0 falls back to the hub default.
    const q = typeof tail === "number" && Number.isFinite(tail) && tail > 0 ? `?tail=${Math.floor(tail)}` : "";
    return this.request("GET", `/apps/${encodeURIComponent(id)}/logs${q}`);
  }
  listDatabases(): Promise<Row[]> {
    return this.request("GET", "/databases");
  }
  backupNow(dbId: string): Promise<Row> {
    return this.request("POST", `/databases/${encodeURIComponent(dbId)}/backups`);
  }

  /** Public, unauthenticated hub version (bare /version, outside the /api/v1 prefix). */
  async getVersion(): Promise<HubVersion> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/version`);
    } catch (e) {
      throw new ApiError(0, `cannot reach ${this.base}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return (await res.json()) as HubVersion;
  }
}
