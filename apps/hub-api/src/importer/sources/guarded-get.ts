import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { assertAllowedUrl, guardedLookup } from "./ssrf-guard";

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
  /** Trailing hint appended to a non-2xx error message (token/allowed-IPs advice). */
  errorHint?: (status: number) => string;
}

/**
 * SSRF-safe authenticated GET client for one external-source instance. Every request validates the URL scheme
 * and pins the connection to a DNS-resolved address the {@link guardedLookup} allows (loopback/link-local/
 * metadata refused). Redirects are refused (a 3xx is a known SSRF pivot), so a response always comes from the
 * validated host. One shared core so each source adapter is a thin wrapper that only differs in the API
 * prefix, the auth header and the error hints.
 */
export class GuardedHttpGet {
  private readonly base: URL;

  constructor(baseUrl: string, private readonly cfg: GuardedGetConfig) {
    this.base = assertAllowedUrl(baseUrl); // throws on a bad scheme / embedded credentials
  }

  get<T>(path: string): Promise<T> {
    const label = this.cfg.label;
    const url = new URL(`${this.cfg.apiPrefix}${path}`, this.base);
    if (url.origin !== this.base.origin) throw new Error(`path escaped the ${label} base origin`); // defence-in-depth
    const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      // Hard overall deadline — independent of the per-byte idle timeout — so a trickled or stalled body
      // cannot keep the request (and its socket) alive indefinitely.
      const deadline = setTimeout(() => {
        req.destroy(new Error(`${label} request exceeded the time limit`));
      }, DEADLINE_MS);

      const req = doRequest(
        url,
        {
          method: "GET",
          headers: { Accept: "application/json", ...this.cfg.headers() },
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
          res.on("end", () =>
            done(() => {
              if (status < 200 || status >= 300) {
                const hint = this.cfg.errorHint?.(status) ?? "";
                return reject(new Error(`${label} API error ${status}${hint}`));
              }
              const body = Buffer.concat(chunks).toString("utf8");
              try {
                resolve(JSON.parse(body) as T);
              } catch {
                reject(new Error(`${label} returned a non-JSON response — is the URL a ${label} API root?`));
              }
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error(`${label} request timed out`)));
      req.on("error", (e) => done(() => reject(e)));
      req.end();
    });
  }
}
