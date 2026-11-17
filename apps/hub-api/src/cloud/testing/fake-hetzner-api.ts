/**
 * An in-memory stand-in for the Hetzner Cloud API (https://api.hetzner.cloud/v1), installed as `global.fetch`, so the
 * real HetznerApiClient is exercised end to end with NO network. It follows the official reference: a bearer token is
 * required (401 `unauthorized` otherwise), server actions are `POST /servers/{id}/actions/{name}` answering 201
 * `{action}`, `enable_rescue` also answers `root_password`, `request_console` answers `wss_url` + `password`, an unknown
 * server is 404 `not_found`, a server with a running action is 423 `locked`, lists are paginated by `page`/`per_page`.
 * Every request is recorded so a test can assert method, path, auth header and payload.
 */
export interface FakeHetznerServer {
  id: number;
  name: string;
  status: string;
  locked?: boolean;
  rescue_enabled?: boolean;
  ipv4?: string | null;
}

export interface RecordedRequest {
  method: string;
  path: string; // path + query, without the host
  authorization: string | null;
  body: unknown;
}

export const FAKE_ROOT_PASSWORD = "RescueRootPw_9f3k2jx0";
export const FAKE_CONSOLE_PASSWORD = "ConsoleVncPw_a8d2m4q1";
export const FAKE_CONSOLE_URL = "wss://console.hetzner.cloud/?server_id=42&token=3db32d15-af2f-459c-8bf8-dee1fd05f49c";

export class FakeHetznerApi {
  readonly requests: RecordedRequest[] = [];
  readonly servers = new Map<number, FakeHetznerServer>();
  /** The one token the fake accepts. */
  validToken = "hz-token";
  /** Make the NEXT request fail with this HTTP status + error code (then clear). status 0 = network failure, -1 = the request was aborted (timeout). */
  failNext: { status: number; code: string; message: string } | null = null;
  /** The next requests never answer until the caller aborts (the client's own timeout), like a stalled connection. */
  hang = false;
  /** The next action response reports this action status (e.g. "error"). */
  nextActionStatus: "running" | "success" | "error" = "running";
  private nextActionId = 1000;
  private original: typeof fetch | undefined;

  add(s: FakeHetznerServer): this {
    this.servers.set(s.id, s);
    return this;
  }

  install(): this {
    this.original = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => this.handle(url, init)) as unknown as typeof fetch;
    return this;
  }

  uninstall(): void {
    if (this.original) (globalThis as { fetch: typeof fetch }).fetch = this.original;
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const path = u.pathname.replace(/^\/v1/, "") + u.search;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path, authorization: headers.authorization ?? null, body });

    if (this.hang) {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort);
      });
    }
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      if (f.status === -1) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); // an aborted request (timeout)
      if (f.status === 0) throw new Error("ECONNRESET");
      return reply(f.status, { error: { code: f.code, message: f.message, details: null } });
    }
    if (headers.authorization !== `Bearer ${this.validToken}`) return reply(401, { error: { code: "unauthorized", message: "unable to authenticate", details: null } });

    const list = /^\/servers$/.exec(u.pathname.replace(/^\/v1/, ""));
    if (list && method === "GET") {
      const per = Math.min(50, Number(u.searchParams.get("per_page") ?? 25));
      const page = Number(u.searchParams.get("page") ?? 1);
      const all = [...this.servers.values()].map(toApi);
      const slice = all.slice((page - 1) * per, page * per);
      const last = Math.max(1, Math.ceil(all.length / per));
      return reply(200, { servers: slice, meta: { pagination: { page, per_page: per, previous_page: page > 1 ? page - 1 : null, next_page: page < last ? page + 1 : null, last_page: last, total_entries: all.length } } });
    }
    const one = /^\/servers\/(\d+)$/.exec(u.pathname.replace(/^\/v1/, ""));
    if (one && method === "GET") {
      const s = this.servers.get(Number(one[1]));
      return s ? reply(200, { server: toApi(s) }) : notFound();
    }
    const act = /^\/servers\/(\d+)\/actions\/([a-z_]+)$/.exec(u.pathname.replace(/^\/v1/, ""));
    if (act && method === "POST") {
      const s = this.servers.get(Number(act[1]));
      if (!s) return notFound();
      if (s.locked) return reply(423, { error: { code: "locked", message: "server is locked", details: null } });
      const name = act[2];
      const action = {
        id: this.nextActionId++,
        command: name,
        status: this.nextActionStatus,
        progress: 0,
        started: "2026-11-28T10:00:00Z",
        finished: null,
        resources: [{ id: s.id, type: "server" }],
        error: this.nextActionStatus === "error" ? { code: "action_failed", message: "Action failed" } : null,
      };
      this.nextActionStatus = "running";
      switch (name) {
        case "poweron":
          s.status = "starting";
          return reply(201, { action });
        case "poweroff":
          s.status = "off";
          return reply(201, { action });
        case "reset":
        case "reboot":
        case "shutdown":
        case "disable_rescue":
          if (name === "disable_rescue") s.rescue_enabled = false;
          return reply(201, { action });
        case "enable_rescue":
          s.rescue_enabled = true;
          return reply(201, { root_password: FAKE_ROOT_PASSWORD, action });
        case "request_console":
          return reply(201, { wss_url: FAKE_CONSOLE_URL, password: FAKE_CONSOLE_PASSWORD, action });
        default:
          return reply(404, { error: { code: "not_found", message: "action not found", details: null } });
      }
    }
    return reply(404, { error: { code: "not_found", message: "route not found", details: null } });
  }
}

function toApi(s: FakeHetznerServer) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    locked: s.locked === true,
    rescue_enabled: s.rescue_enabled === true,
    public_net: { ipv4: s.ipv4 === null ? null : { ip: s.ipv4 ?? "203.0.113.10" }, ipv6: null },
  };
}

function notFound(): Response {
  return reply(404, { error: { code: "not_found", message: "server not found", details: null } });
}

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
