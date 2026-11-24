import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { assertAllowedUrl, guardedLookup } from "./ssrf-guard";
import { AuthPausedError, retryAfterHeader, type RequestLimits } from "./request-limits";
import { safeApiMessage } from "./api-message";

const TIMEOUT_MS = 15_000; // per-socket idle timeout
const DEADLINE_MS = 30_000; // hard overall cap: a trickle/stalled response cannot hang the request forever
const MAX_BYTES = 16 * 1024 * 1024; // guard against a hostile/huge response

export interface GuardedGetConfig {
  /** The API path prefix on the base origin, e.g. "/api/v1" (Coolify) or "/api" (Dokploy). */
  apiPrefix: string;
  /** Short label for messages, e.g. "Coolify" / "Dokploy". */
  label: string;
  /** Per-request headers (auth + accept). A thunk so a rotated token is read fresh each call. */
  headers: () => Record<string, string>;
  /**
   * Trailing hint appended to a non-2xx error message (token/allowed-IPs advice). `ctx.message` is the safe excerpt of the
   * response's JSON `message` (only when {@link includeApiMessage} is on and the status is 4xx), `ctx.egressIp` this hub's
   * public address (only for a 403, only when {@link egressIp} is wired and knows it).
   */
  errorHint?: (status: number, ctx?: ErrorHintContext) => string;
  /** Keep the first ~100 safe characters of a 4xx response's JSON `message` in the error (Coolify: tells the 403 causes apart). */
  includeApiMessage?: boolean;
  /** This hub's egress IP as far as it is known (null = unknown); asked only when a 403 hint is built. Never throws into the request. */
  egressIp?: () => Promise<string | null>;
  /** Optional pacing + 429/lockout handling (Coolify 4.7+). Absent = every non-2xx is surfaced as-is (Dokploy). */
  limits?: RequestLimits;
  /** Test seam: replaces the socket. The real transport is SSRF-pinned; an injected one is only ever used by specs. */
  transport?: RawTransport;
}

export interface ErrorHintContext {
  message?: string | null;
  egressIp?: string | null;
}

/** A raw response: any non-redirect status, the body (size-capped) and the `Retry-After` header. */
export interface RawGetResponse {
  status: number;
  retryAfter?: string | null;
  body: Buffer;
}
/** `method`/`body` are only set by {@link GuardedHttpGet.postJson} (a source whose login is a POST, e.g. Beszel). */
export interface RawRequestInit {
  method?: "GET" | "POST";
  body?: string;
}
export type RawTransport = (url: URL, headers: Record<string, string>, init?: RawRequestInit) => Promise<RawGetResponse>;

/**
 * SSRF-safe authenticated GET client for one external-source instance. Every request validates the URL scheme
 * and pins the connection to a DNS-resolved address the {@link guardedLookup} allows (loopback/link-local/
 * metadata refused). Redirects are refused (a 3xx is a known SSRF pivot), so a response always comes from the
 * validated host. One shared core so each source adapter is a thin wrapper that only differs in the API
 * prefix, the auth header and the error hints.
 */
export class GuardedHttpGet {
  private readonly base: URL;
  private readonly transport: RawTransport;

  constructor(baseUrl: string, private readonly cfg: GuardedGetConfig) {
    this.base = assertAllowedUrl(baseUrl); // throws on a bad scheme / embedded credentials
    this.transport = cfg.transport ?? guardedRequest(cfg.label);
  }

  get<T>(path: string): Promise<T> {
    return this.fetchBody(path, "application/json", (body) => this.parseJson<T>(body));
  }

  /** The same guarded transport for a JSON POST (login endpoints). Redirects are refused exactly like a GET. */
  postJson<T>(path: string, payload: unknown): Promise<T> {
    return this.fetchBody(path, "application/json", (body) => this.parseJson<T>(body), { method: "POST", body: JSON.stringify(payload) });
  }

  private parseJson<T>(body: string): T {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`${this.cfg.label} returned a non-JSON response — is the URL a ${this.cfg.label} API root?`);
    }
  }

  /** The same guarded GET for an endpoint that answers PLAIN TEXT (Coolify's `GET /version`), capped small: a token, never a document. */
  getText(path: string): Promise<string> {
    return this.fetchBody(path, "text/plain, */*;q=0.1", (body) => {
      if (body.length > 256) throw new Error(`${this.cfg.label} returned an unexpectedly long text response`);
      return body;
    });
  }

  /** The values that must never appear in an error: the configured credentials (each header value, minus the Accept header). */
  private secrets(): string[] {
    return Object.entries(this.cfg.headers())
      .filter(([k]) => k.toLowerCase() !== "accept")
      .map(([, v]) => v);
  }

  private async hintContext(status: number, message: string | null): Promise<ErrorHintContext> {
    let egressIp: string | null = null;
    if (status === 403 && this.cfg.egressIp) {
      try {
        egressIp = await this.cfg.egressIp();
      } catch {
        egressIp = null; // an unresolvable address must never hide the real error
      }
    }
    return { message, egressIp };
  }

  private async fetchBody<T>(path: string, accept: string, parse: (body: string) => T, init?: RawRequestInit): Promise<T> {
    const label = this.cfg.label;
    const url = new URL(`${this.cfg.apiPrefix}${path}`, this.base);
    if (url.origin !== this.base.origin) throw new Error(`path escaped the ${label} base origin`); // defence-in-depth
    const headers: Record<string, string> = { Accept: accept, ...this.cfg.headers() };
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";
    const send = () => this.transport(url, headers, init);
    let res: RawGetResponse;
    try {
      res = this.cfg.limits ? await this.cfg.limits.run(send) : await send();
    } catch (e) {
      if (e instanceof AuthPausedError) {
        const hint = this.cfg.errorHint?.(e.status, await this.hintContext(e.status, null)) ?? "";
        throw new Error(`${label} API error ${e.status}${hint} — requests paused for ${Math.ceil(e.retryAfterMs / 1000)} s after repeated authorization failures, so the token is not locked out`);
      }
      throw e;
    }
    if (res.status < 200 || res.status >= 300) {
      const is4xx = res.status >= 400 && res.status < 500;
      const message = this.cfg.includeApiMessage && is4xx ? safeApiMessage(res.body, this.secrets()) : null;
      const hint = this.cfg.errorHint?.(res.status, await this.hintContext(res.status, message)) ?? "";
      throw new Error(`${label} API error ${res.status}${message ? `: "${message}"` : ""}${hint}`);
    }
    return parse(res.body.toString("utf8"));
  }
}

/** The real transport: one SSRF-pinned GET that resolves with ANY non-redirect status (the caller interprets it). */
function guardedRequest(label: string): RawTransport {
  return (url, headers, init) => {
    const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<RawGetResponse>((resolve, reject) => {
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
          method: init?.method ?? "GET",
          headers: init?.body !== undefined ? { ...headers, "Content-Length": String(Buffer.byteLength(init.body)) } : headers,
          lookup: guardedLookup,
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            return done(() => reject(new Error(`${label} returned a redirect (${status}) — refused by the SSRF guard`)));
          }
          const chunks: Buffer[] = [];
          let len = 0;
          res.on("data", (c: Buffer) => {
            len += c.length;
            if (len > MAX_BYTES) {
              req.destroy();
              done(() => reject(new Error(`${label} response too large`)));
              return;
            }
            chunks.push(c);
          });
          res.on("aborted", () => done(() => reject(new Error(`${label} response was truncated`))));
          const ra = retryAfterHeader(res.headers);
          res.on("end", () => done(() => resolve({ status, retryAfter: ra, body: Buffer.concat(chunks) })));
        },
      );
      // Hard overall deadline — set AFTER req exists so a synchronous throw from doRequest can never leave an
      // orphan timer that later dereferences an unassigned req (a remote-triggered crash). Independent of the
      // per-byte idle timeout, so a trickled/stalled body cannot keep the socket alive indefinitely.
      const deadline = setTimeout(() => {
        req.destroy(new Error(`${label} request exceeded the time limit`));
      }, DEADLINE_MS);
      req.on("timeout", () => req.destroy(new Error(`${label} request timed out`)));
      req.on("error", (e) => done(() => reject(e)));
      req.end(init?.body);
    });
  };
}
