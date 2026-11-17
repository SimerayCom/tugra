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

/** The subset of GET /apps/:id/labels the CLI reads (the full object flows through `--json`). */
export interface AppLabelsView {
  engine: string;
  editable: boolean;
  tugra: { scope: string; key: string; value: string | null; masked: boolean; purpose: string }[];
  custom: { key: string; value: string }[];
  fromDockerOptions: { key: string; value: string }[];
  [k: string]: unknown;
}

/** The subset of GET /import/operations/:opId/volumes the CLI reads (the full object flows through `--json`). */
export interface ImportVolumesView {
  enabled: boolean;
  tokenExpiresAt: string | null;
  volumes: {
    itemRef: string;
    resourceName: string | null;
    state: string;
    phase: string | null;
    partsDone: number;
    rawBytesDone: number;
    rawBytesTotal: number | null;
    bps: number | null;
    etaSec: number | null;
    error: string | null;
    [k: string]: unknown;
  }[];
}

/** The subset of a ServerReboot view the CLI reads (the full object flows through `--json`). */
export interface RebootReportView {
  rebooted: boolean;
  docker: string;
  containers: { name: string; image: string; restartPolicy: string; verdict: string; detail?: string }[];
  domains: { host: string; verdict: string; status: number | null }[];
  domainsNote?: string;
  rebootRequired: string;
  reason?: string;
  summary: { containersOk: number; containersExpected: number; domainsOk: number; domainsExpected: number };
  [k: string]: unknown;
}
export interface RebootViewShape {
  id: string;
  mode: "now" | "scheduled";
  state: string;
  result: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  agentBackAt: string | null;
  verifiedAt: string | null;
  snapshot: { containers: number; domains: number; hostsHub: boolean } | null;
  report: RebootReportView | null;
  [k: string]: unknown;
}
export interface RebootStatusShape {
  active: RebootViewShape | null;
  last: RebootViewShape | null;
}
export interface RebootPreviewShape {
  containers: number;
  domains: number;
  hostsHub: boolean;
  agentOnline: boolean;
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
  /** GET /servers/:id — the CLI needs only the name (the typed confirmation of a reboot). */
  getServer(id: string): Promise<{ id: string; name: string } & Row> {
    return this.request("GET", `/servers/${encodeURIComponent(id)}`);
  }
  /** GET /servers/:id/reboot — the live reboot (if any) and the last finished one with its verification report. */
  getServerReboot(id: string): Promise<RebootStatusShape> {
    return this.request("GET", `/servers/${encodeURIComponent(id)}/reboot`);
  }
  /** GET /servers/:id/reboot/preview — what a reboot takes down (counts). */
  getServerRebootPreview(id: string): Promise<RebootPreviewShape> {
    return this.request("GET", `/servers/${encodeURIComponent(id)}/reboot/preview`);
  }
  /** POST /servers/:id/reboot — `confirmName` must equal the server's name (the hub refuses otherwise). */
  requestServerReboot(id: string, body: { mode: "now"; confirmName: string } | { mode: "scheduled"; at: string; confirmName: string }): Promise<RebootViewShape> {
    return this.request("POST", `/servers/${encodeURIComponent(id)}/reboot`, body);
  }
  /** DELETE /servers/:id/reboot — cancel a SCHEDULED reboot. */
  cancelServerReboot(id: string): Promise<RebootViewShape> {
    return this.request("DELETE", `/servers/${encodeURIComponent(id)}/reboot`);
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
  /** GET /import/operations/:opId/volumes — the streamed volume copies of a fleet import (read-only). */
  getImportVolumes(opId: string): Promise<ImportVolumesView> {
    return this.request("GET", `/import/operations/${encodeURIComponent(opId)}/volumes`);
  }
  /** POST .../volumes/:itemRef/abort — stop one copy (a live migrator's next call exits). */
  abortImportVolume(opId: string, itemRef: string): Promise<Row> {
    return this.request("POST", `/import/operations/${encodeURIComponent(opId)}/volumes/${encodeURIComponent(itemRef)}/abort`);
  }
  /** POST .../volumes/:itemRef/reset — discard one volume's staged parts and the partial destination. */
  resetImportVolume(opId: string, itemRef: string): Promise<Row> {
    return this.request("POST", `/import/operations/${encodeURIComponent(opId)}/volumes/${encodeURIComponent(itemRef)}/reset`);
  }
  /** GET /apps/:id/labels — every label Tugra applies (read-only) + the custom ones (writer-only). */
  getAppLabels(id: string): Promise<AppLabelsView> {
    return this.request("GET", `/apps/${encodeURIComponent(id)}/labels`);
  }
  /** PUT /apps/:id/custom-labels — replaces the FULL custom-label map; `{}` resets to defaults. */
  setAppCustomLabels(id: string, labels: Record<string, string>): Promise<Row> {
    return this.request("PUT", `/apps/${encodeURIComponent(id)}/custom-labels`, { labels });
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
