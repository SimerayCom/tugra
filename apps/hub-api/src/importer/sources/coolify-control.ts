import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { assertAllowedUrl, guardedLookup } from "./ssrf-guard";
import { AuthPausedError, RateLimitedError, coolifyLimits, type RequestLimits } from "./request-limits";

/**
 * The WRITE half of a Coolify instance (P7 lane B): stop / start / read the state of ONE application, service or
 * database through the Coolify REST API. Everything else in `sources/` is read-only (`discover`); this exists only so a
 * guided migration can freeze the source writers (and put them back on abort) when the owner answered "api" to the
 * source-controller question and supplied a token that is allowed to write.
 *
 * Boundary rules (mirrors {@link GuardedHttpGet}):
 *  - the base URL goes through {@link assertAllowedUrl} and every connection through {@link guardedLookup} (SSRF),
 *  - redirects are refused, the response is size-capped and has a hard deadline,
 *  - the token only ever travels in the Authorization header; no error carries a response body, a URL or the token
 *    (a failure is a fixed {@link ControlErrorCode}, which is what the run engine stores and the web localizes),
 *  - it never deletes anything: there is no remove method on purpose.
 *
 * Start/stop semantics (Coolify 4.7.5, verified against its source):
 *  - the verbs are `POST /{applications|services|databases}/{uuid}/{start|stop}`. Older v4 releases exposed them as `GET`;
 *    a POST answered 405 there, so {@link CoolifyControl} falls back to `GET` on a 405 ONLY. A POST 404 is a resource that
 *    does not exist and stays `not-found` (4.7.5 answers 405 to every GET start/stop, so falling back would hide it);
 *  - `POST /applications/{uuid}/start` is `action_deploy`: it QUEUES A DEPLOYMENT (a rebuild), it is not a `docker start`.
 *    For an application the abort path therefore re-deploys the stopped app; databases and services are really started;
 *  - a database or service that is already in the requested state answers 400 "already stopped" / "already running":
 *    that is the desired end state, so it is success here (the start/stop is idempotent for the caller);
 *  - a stop defaults to `docker_cleanup=true`, which runs a docker prune on the SOURCE host after the stop. A migration
 *    must not touch anything else on the source, so every stop sends `docker_cleanup=false`;
 *  - the token needs the literal `deploy` ability (Sanctum matches abilities literally: `write` alone gets a 403).
 *    Reading the state needs `read`.
 */

export const CONTROL_ERROR_CODES = ["forbidden", "unauthorized", "not-found", "unreachable", "rejected", "bad-response", "rate-limited"] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

/** A control failure with a FIXED code. `message` equals the code: nothing from the remote ever lands in it. */
export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode) {
    super(code);
    this.name = "ControlError";
  }
}

export const COOLIFY_RESOURCE_KINDS = ["application", "service", "database"] as const;
export type CoolifyResourceKind = (typeof COOLIFY_RESOURCE_KINDS)[number];

/** What the control plane believes a resource is doing. `unknown` = transitional (starting/restarting/degraded) or unparseable. */
export type ControlState = "running" | "stopped" | "unknown";

export interface ControlTransportResponse {
  status: number;
  body: unknown;
}

/** The transport seam: the real one is the guarded HTTP client below, tests inject a recorder. */
export interface CoolifyControlTransport {
  request(method: "GET" | "POST", path: string): Promise<ControlTransportResponse>;
}

const UUID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const COLLECTION: Record<CoolifyResourceKind, string> = { application: "applications", service: "services", database: "databases" };

/** The Coolify uuid of an importer itemRef (`app:<serverRef|_>:<uuid>`, `service:...`, `database:...`), or null. */
export function coolifyRefOf(itemRef: string): { kind: CoolifyResourceKind; uuid: string } | null {
  const parts = itemRef.split(":");
  if (parts.length !== 3) return null;
  const kind = parts[0] === "app" ? "application" : parts[0] === "service" ? "service" : parts[0] === "database" ? "database" : null;
  if (!kind || !UUID_RE.test(parts[2])) return null;
  return { kind, uuid: parts[2] };
}

/** Map a Coolify `status` string (`running:healthy`, `exited:unhealthy`, `stopped`, `degraded:unhealthy`...) to a {@link ControlState}. */
export function parseCoolifyStatus(raw: unknown): ControlState {
  if (typeof raw !== "string") return "unknown";
  const s = raw.trim().toLowerCase();
  if (s.startsWith("running")) return "running";
  if (s.startsWith("exited") || s.startsWith("stopped")) return "stopped";
  return "unknown";
}

export class CoolifyControl {
  constructor(private readonly transport: CoolifyControlTransport) {}

  /** The real, SSRF-guarded client for one instance. */
  static http(baseUrl: string, token: string): CoolifyControl {
    return new CoolifyControl(new GuardedHttpTransport(baseUrl, token));
  }

  private path(kind: CoolifyResourceKind, uuid: string, suffix = ""): string {
    if (!(COOLIFY_RESOURCE_KINDS as readonly string[]).includes(kind) || !UUID_RE.test(uuid)) throw new ControlError("rejected");
    return `/${COLLECTION[kind]}/${uuid}${suffix}`;
  }

  /** Read the current state (`GET /<collection>/<uuid>`). */
  async state(kind: CoolifyResourceKind, uuid: string): Promise<ControlState> {
    const res = await this.transport.request("GET", this.path(kind, uuid));
    this.assertOk(res.status);
    const body = res.body;
    if (!body || typeof body !== "object") throw new ControlError("bad-response");
    return parseCoolifyStatus((body as { status?: unknown }).status);
  }

  /** Stop one resource (no docker cleanup on the source host). Idempotent. Resolves once Coolify ACCEPTED the request; the caller confirms with {@link state}. */
  async stop(kind: CoolifyResourceKind, uuid: string): Promise<void> {
    await this.act(kind, uuid, "stop");
  }

  /** Start one resource again (the abort path). Idempotent. For an application this queues a deploy (see the file header). */
  async start(kind: CoolifyResourceKind, uuid: string): Promise<void> {
    await this.act(kind, uuid, "start");
  }

  private async act(kind: CoolifyResourceKind, uuid: string, verb: "stop" | "start"): Promise<void> {
    // docker_cleanup=false on a stop: Coolify's default runs a docker prune on the source host after the stop.
    const p = this.path(kind, uuid, `/${verb}`) + (verb === "stop" ? "?docker_cleanup=false" : "");
    let res = await this.transport.request("POST", p);
    // An older Coolify exposes start/stop as GET only (a POST is a 405 there). A 404 is NOT a verb problem: the resource is gone.
    if (res.status === 405) res = await this.transport.request("GET", p);
    if (res.status === 400 && alreadyInState(verb, res.body)) return; // "Database is already stopped" / "Service is already running": the wanted state
    this.assertOk(res.status);
  }

  private assertOk(status: number): void {
    if (status >= 200 && status < 300) return;
    if (status === 401) throw new ControlError("unauthorized");
    if (status === 403) throw new ControlError("forbidden");
    if (status === 404) throw new ControlError("not-found");
    if (status === 429) throw new ControlError("rate-limited"); // retryable: the limit lifts on its own
    if (status >= 500 || status === 0) throw new ControlError("unreachable");
    throw new ControlError("rejected");
  }
}

const ALREADY_STOPPED_RE = /\balready\s+(stopped|exited)\b/i;
const ALREADY_RUNNING_RE = /\balready\s+(running|started)\b/i;

/** Whether a 400 body is Coolify saying the resource is ALREADY in the state this verb asks for. The message is only matched, never returned. */
function alreadyInState(verb: "stop" | "start", body: unknown): boolean {
  const msg = body && typeof body === "object" ? (body as { message?: unknown }).message : undefined;
  if (typeof msg !== "string") return false;
  return (verb === "stop" ? ALREADY_STOPPED_RE : ALREADY_RUNNING_RE).test(msg);
}

// ───────────────────────────── guarded transport ─────────────────────────────

const TIMEOUT_MS = 15_000;
const DEADLINE_MS = 30_000;
const MAX_BYTES = 1024 * 1024;

class GuardedHttpTransport implements CoolifyControlTransport {
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly limits?: RequestLimits,
  ) {
    this.base = assertAllowedUrl(baseUrl);
    this.limits ??= coolifyLimits.for(baseUrl, token);
  }

  /** Paced under Coolify's per-user limit; a 429 honours a bounded Retry-After; a token that keeps failing authorization is paused. */
  async request(method: "GET" | "POST", path: string): Promise<ControlTransportResponse> {
    try {
      const res = await this.limits!.run(() => this.once(method, path));
      return { status: res.status, body: res.body };
    } catch (e) {
      if (e instanceof RateLimitedError) return { status: 429, body: null };
      if (e instanceof AuthPausedError) return { status: e.status, body: null };
      throw e;
    }
  }

  private once(method: "GET" | "POST", path: string): Promise<ControlTransportResponse & { retryAfter: string | null }> {
    const url = new URL(`/api/v1${path}`, this.base);
    if (url.origin !== this.base.origin) return Promise.reject(new ControlError("rejected")); // defence in depth
    const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      const req = doRequest(
        url,
        {
          method,
          headers: { Accept: "application/json", Authorization: `Bearer ${this.token}`, ...(method === "POST" ? { "Content-Length": "0" } : {}) },
          lookup: guardedLookup,
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            return done(() => reject(new ControlError("rejected"))); // a redirect is a known SSRF pivot
          }
          const chunks: Buffer[] = [];
          let len = 0;
          res.on("data", (c: Buffer) => {
            len += c.length;
            if (len > MAX_BYTES) {
              req.destroy();
              done(() => reject(new ControlError("bad-response")));
              return;
            }
            chunks.push(c);
          });
          const ra = res.headers["retry-after"];
          res.on("aborted", () => done(() => reject(new ControlError("unreachable"))));
          res.on("end", () =>
            done(() => {
              let body: unknown = null;
              try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                /* a non-JSON body only matters to `state`, which then reports bad-response */
              }
              resolve({ status, body, retryAfter: Array.isArray(ra) ? ra[0] : (ra ?? null) });
            }),
          );
        },
      );
      const deadline = setTimeout(() => req.destroy(new Error("deadline")), DEADLINE_MS);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => done(() => reject(new ControlError("unreachable"))));
      req.end();
    });
  }
}
