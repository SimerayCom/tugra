import { Injectable } from "@nestjs/common";
import type {
  CloudOobProvider,
  CloudPlanProvider,
  CloudProvider,
  CloudServerCreateOpts,
  CloudServerCreateResult,
  ConsoleSession,
  EnableRescueResult,
  OobPowerAction,
  ProviderActionResult,
  ProviderPlan,
  ProviderServerPlan,
  ProviderServerState,
} from "./cloud-provider.interface";

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";
const HETZNER_TIMEOUT_MS = 20_000;

/** A Hetzner Cloud API failure. `status` 0 = the request never completed: `timedOut` = our timeout aborted it (Hetzner may still have acted), else a connection failure. */
export class HetznerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hetznerError?: unknown,
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = "HetznerApiError";
  }
}

interface HetznerAction {
  id?: number | string;
  command?: string;
  status?: string;
  error?: { code?: string; message?: string } | null;
}

/** The documented lifetime of a console `wss_url` (docs.hetzner.cloud: "valid for 1 minute"). */
const CONSOLE_URL_VALID_SECONDS = 60;
/** Hetzner list endpoints cap per_page at 50; the picker reads at most this many pages (250 VMs). */
const LIST_PER_PAGE = 50;
const LIST_MAX_PAGES = 5;

// Server action endpoints (POST /servers/{id}/actions/<name>, no body, 201 {action}). The names are Hetzner's:
// their "reboot" is a soft ACPI reboot and "reset" the hard one; our `reboot` is the hard one (see OobPowerAction).
const POWER_ENDPOINT: Record<OobPowerAction, string> = {
  power_on: "poweron",
  power_off: "poweroff",
  reboot: "reset",
  shutdown: "shutdown",
};

interface HetznerPrice {
  location?: string;
  price_monthly?: { net?: string | number; gross?: string | number } | null;
}

interface HetznerServerType {
  name?: string;
  cores?: number;
  memory?: number;
  disk?: number;
  architecture?: string;
  deprecated?: boolean | null;
  deprecation?: unknown;
  prices?: HetznerPrice[] | null;
}

interface HetznerServer {
  id: number | string;
  server_type?: HetznerServerType | null;
  datacenter?: { location?: { name?: string } | null } | null;
  location?: { name?: string } | null;
  name?: string;
  status?: string;
  locked?: boolean;
  rescue_enabled?: boolean;
  public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null } | null;
  // root_password may be present when no SSH key is supplied — intentionally never read.
}

/**
 * Thin, injectable Hetzner Cloud API client (mirrors CloudflareApiClient). The token is passed to
 * every method explicitly (never stored on `this`) and is never interpolated into a thrown/logged
 * message — a leaked exception must not reveal the credential from the Authorization header.
 */
@Injectable()
export class HetznerApiClient implements CloudProvider, CloudOobProvider, CloudPlanProvider {
  readonly name = "hetzner";

  /** GET /locations — cheapest authenticated call. 200 → valid; 401/403 → invalid (not a throw). */
  async verifyToken(token: string): Promise<{ valid: boolean }> {
    try {
      await this.request("GET", "/locations", token);
      return { valid: true };
    } catch (e) {
      if (e instanceof HetznerApiError && (e.status === 401 || e.status === 403)) return { valid: false };
      throw e;
    }
  }

  /** POST /servers — create + boot a VM running the given cloud-init user-data. */
  async createServer(token: string, opts: CloudServerCreateOpts): Promise<CloudServerCreateResult> {
    const res = await this.request<{ server?: HetznerServer }>("POST", "/servers", token, {
      name: opts.name,
      server_type: opts.serverType,
      image: opts.image,
      location: opts.location,
      user_data: opts.userData,
      start_after_create: true,
      public_net: { enable_ipv4: true, enable_ipv6: true },
    });
    const server = res?.server;
    if (!server?.id) throw new HetznerApiError("hetzner did not return a server id", 502);
    // server.root_password (set when no SSH key is provided) is deliberately DISCARDED — access is
    // only ever via the Tugra agent, and the password must never be stored or logged.
    return {
      providerServerId: String(server.id),
      publicIp: server.public_net?.ipv4?.ip ?? null,
      publicIpv6: server.public_net?.ipv6?.ip ?? null,
    };
  }

  /** DELETE /servers/{id}; an already-gone (404) server resolves normally (idempotent teardown). */
  async destroyServer(token: string, providerServerId: string): Promise<void> {
    try {
      await this.request("DELETE", `/servers/${encodeURIComponent(providerServerId)}`, token);
    } catch (e) {
      if (e instanceof HetznerApiError && e.status === 404) return;
      throw e;
    }
  }

  /** GET /servers/{id} — power status, lock, rescue flag and addresses. */
  async getServerState(token: string, providerServerId: string): Promise<ProviderServerState> {
    const res = await this.request<{ server?: HetznerServer }>("GET", `/servers/${serverPathId(providerServerId)}`, token);
    if (!res?.server?.id) throw new HetznerApiError("hetzner did not return the server", 502);
    return toState(res.server);
  }

  /** GET /servers?per_page=50&page=N (bounded to LIST_MAX_PAGES pages). */
  async listServers(token: string): Promise<ProviderServerState[]> {
    const out: ProviderServerState[] = [];
    let page = 1;
    while (page <= LIST_MAX_PAGES) {
      const res = await this.request<{ servers?: HetznerServer[]; meta?: { pagination?: { next_page?: number | null } } }>(
        "GET",
        `/servers?per_page=${LIST_PER_PAGE}&page=${page}`,
        token,
      );
      for (const s of res?.servers ?? []) if (s?.id) out.push(toState(s));
      const next = res?.meta?.pagination?.next_page;
      if (!next || next <= page) break;
      page = next;
    }
    return out;
  }

  /** poweron | poweroff | reset | shutdown — a 201 {action}; an action that already failed is an error. */
  async power(token: string, providerServerId: string, action: OobPowerAction): Promise<ProviderActionResult> {
    const res = await this.request<{ action?: HetznerAction }>("POST", `/servers/${serverPathId(providerServerId)}/actions/${POWER_ENDPOINT[action]}`, token);
    return toAction(res?.action);
  }

  /** enable_rescue ({"type":"linux64"}) — 201 {root_password, action}. Rescue boots on the NEXT (re)boot and turns
   *  itself off after the first boot into it or after 60 minutes. The password is returned to the caller only. */
  async enableRescue(token: string, providerServerId: string): Promise<EnableRescueResult> {
    const res = await this.request<{ action?: HetznerAction; root_password?: string }>(
      "POST",
      `/servers/${serverPathId(providerServerId)}/actions/enable_rescue`,
      token,
      { type: "linux64" },
    );
    if (typeof res?.root_password !== "string" || !res.root_password) throw new HetznerApiError("hetzner did not return a rescue password", 502);
    return { action: toAction(res.action), rootPassword: res.root_password };
  }

  async disableRescue(token: string, providerServerId: string): Promise<ProviderActionResult> {
    const res = await this.request<{ action?: HetznerAction }>("POST", `/servers/${serverPathId(providerServerId)}/actions/disable_rescue`, token);
    return toAction(res?.action);
  }

  /** request_console — 201 {wss_url, password, action}: VNC over websocket, URL valid for one minute. */
  async requestConsole(token: string, providerServerId: string): Promise<ConsoleSession> {
    const res = await this.request<{ action?: HetznerAction; wss_url?: string; password?: string }>(
      "POST",
      `/servers/${serverPathId(providerServerId)}/actions/request_console`,
      token,
    );
    if (typeof res?.wss_url !== "string" || typeof res?.password !== "string" || !res.wss_url || !res.password) {
      throw new HetznerApiError("hetzner did not return a console session", 502);
    }
    return { action: toAction(res.action), wssUrl: res.wss_url, password: res.password, validForSeconds: CONSOLE_URL_VALID_SECONDS };
  }

  /** GET /servers (bounded pages): each VM with its plan and the plan's monthly net price at the VM's location. */
  async listServerPlans(token: string): Promise<ProviderServerPlan[]> {
    const out: ProviderServerPlan[] = [];
    let page = 1;
    while (page <= LIST_MAX_PAGES) {
      const res = await this.request<{ servers?: HetznerServer[]; meta?: { pagination?: { next_page?: number | null } } }>(
        "GET",
        `/servers?per_page=${LIST_PER_PAGE}&page=${page}`,
        token,
      );
      for (const s of res?.servers ?? []) {
        const p = toServerPlan(s);
        if (p) out.push(p);
      }
      const next = res?.meta?.pagination?.next_page;
      if (!next || next <= page) break;
      page = next;
    }
    return out;
  }

  /** GET /server_types (bounded pages): every plan with its monthly net price per location. */
  async listPlanCatalog(token: string): Promise<ProviderPlan[]> {
    const out: ProviderPlan[] = [];
    let page = 1;
    while (page <= LIST_MAX_PAGES) {
      const res = await this.request<{ server_types?: HetznerServerType[]; meta?: { pagination?: { next_page?: number | null } } }>(
        "GET",
        `/server_types?per_page=${LIST_PER_PAGE}&page=${page}`,
        token,
      );
      for (const t of res?.server_types ?? []) {
        const spec = toPlanSpec(t);
        if (!spec) continue;
        const monthlyCentsByLocation: Record<string, number> = {};
        for (const pr of t.prices ?? []) {
          const c = pr?.location ? netCents(pr.price_monthly?.net) : null;
          if (c !== null && pr.location) monthlyCentsByLocation[pr.location] = c;
        }
        out.push({ ...spec, deprecated: t.deprecated === true || (t.deprecation !== null && t.deprecation !== undefined), monthlyCentsByLocation, currency: "EUR" });
      }
      const next = res?.meta?.pagination?.next_page;
      if (!next || next <= page) break;
      page = next;
    }
    return out;
  }

  /** GET /servers/{id} read as plan + price. */
  async getServerPlan(token: string, providerServerId: string): Promise<ProviderServerPlan> {
    const res = await this.request<{ server?: HetznerServer }>("GET", `/servers/${serverPathId(providerServerId)}`, token);
    const p = res?.server ? toServerPlan(res.server) : null;
    if (!p) throw new HetznerApiError("hetzner did not return the server plan", 502);
    return p;
  }

  /** POST change_type: the VM must be off. `upgrade_disk: false` keeps the disk so the VM can be moved back later. */
  async changeType(token: string, providerServerId: string, planSlug: string, upgradeDisk: boolean): Promise<ProviderActionResult> {
    if (!/^[a-z0-9]{2,16}$/.test(planSlug)) throw new HetznerApiError("invalid hetzner server type", 422);
    const res = await this.request<{ action?: HetznerAction }>("POST", `/servers/${serverPathId(providerServerId)}/actions/change_type`, token, {
      server_type: planSlug,
      upgrade_disk: upgradeDisk,
    });
    return toAction(res?.action);
  }

  private async request<T = unknown>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HETZNER_TIMEOUT_MS);
    try {
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${HETZNER_API_BASE}${path}`, {
          method,
          signal: ctrl.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        // Network/timeout: never surface the token that lived in the request headers.
        if (ctrl.signal.aborted || (e as { name?: string })?.name === "AbortError") throw new HetznerApiError("hetzner api timed out", 0, undefined, true);
        throw new HetznerApiError("hetzner api unreachable", 0);
      }
      if (res.status === 204) return undefined as T;
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
        const msg = hetznerErrorMessage(err) ?? `hetzner api error (HTTP ${res.status})`;
        throw new HetznerApiError(msg, res.status, err);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Hetzner errors come from the RESPONSE body (never the token) so this message is safe to surface. */
function hetznerErrorMessage(error: { code?: string; message?: string } | undefined): string | null {
  if (error?.message) return `hetzner: ${error.message}`;
  return null;
}

/** Hetzner server ids are positive integers; anything else is rejected before it can shape a URL path. */
function serverPathId(id: string): string {
  if (!/^[1-9]\d{0,18}$/.test(id)) throw new HetznerApiError("invalid hetzner server id", 422);
  return id;
}

function toState(s: HetznerServer): ProviderServerState {
  return {
    providerServerId: String(s.id),
    name: typeof s.name === "string" ? s.name : "",
    status: typeof s.status === "string" ? s.status : "unknown",
    locked: s.locked === true,
    rescueEnabled: s.rescue_enabled === true,
    publicIpv4: s.public_net?.ipv4?.ip ?? null,
    publicIpv6: s.public_net?.ipv6?.ip ?? null,
  };
}

/** An action Hetzner reports as already failed is an error to the caller (its message is response-derived, token-free). */
function toAction(a: HetznerAction | undefined): ProviderActionResult {
  if (!a || a.id === undefined || a.id === null) throw new HetznerApiError("hetzner did not return an action", 502);
  const status = a.status === "success" || a.status === "error" ? a.status : "running";
  if (status === "error") throw new HetznerApiError(hetznerErrorMessage(a.error ?? undefined) ?? "hetzner action failed", 502, a.error);
  return { id: String(a.id), status, command: typeof a.command === "string" ? a.command : "" };
}

/** "5.8300000000" (a net price string, as Hetzner sends it) to integer cents; null when it is not a usable number. */
export function netCents(v: string | number | null | undefined): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function toPlanSpec(t: HetznerServerType | null | undefined): ProviderServerPlan["plan"] | null {
  if (!t || typeof t.name !== "string" || !/^[a-z0-9]{2,16}$/.test(t.name)) return null;
  if (!Number.isFinite(t.cores) || !Number.isFinite(t.memory) || !Number.isFinite(t.disk)) return null;
  return { slug: t.name, cores: Number(t.cores), memoryGb: Number(t.memory), diskGb: Number(t.disk), architecture: t.architecture === "arm" ? "arm" : "x86" };
}

function toServerPlan(s: HetznerServer): ProviderServerPlan | null {
  const plan = toPlanSpec(s.server_type);
  if (!s.id || !plan) return null;
  const location = s.location?.name ?? s.datacenter?.location?.name ?? null;
  const price = (s.server_type?.prices ?? []).find((p) => p?.location === location);
  return { providerServerId: String(s.id), plan, location, monthlyCents: netCents(price?.price_monthly?.net), currency: "EUR" };
}
