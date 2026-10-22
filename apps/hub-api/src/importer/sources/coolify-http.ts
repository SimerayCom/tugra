import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { assertAllowedUrl, guardedLookup } from "./ssrf-guard";
import type { CoolifyClient } from "./coolify.source";

const TIMEOUT_MS = 15_000; // per-socket idle timeout
const DEADLINE_MS = 30_000; // hard overall cap: a trickle/stalled response cannot hang the request forever
const MAX_BYTES = 16 * 1024 * 1024; // guard against a hostile/huge response

/**
 * SSRF-safe authenticated GET client for one Coolify instance. Every request validates the URL scheme and
 * pins the connection to a DNS-resolved address the {@link guardedLookup} allows (loopback/link-local/
 * metadata refused). Redirects are refused (a 3xx is a known SSRF pivot), so a response always comes from the
 * validated host. The Coolify REST API lives under `/api/v1`.
 */
export class CoolifyHttpClient implements CoolifyClient {
  private readonly base: URL;

  constructor(baseUrl: string, private readonly token: string) {
    this.base = assertAllowedUrl(baseUrl); // throws on a bad scheme / embedded credentials
  }

  get<T>(path: string): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.base);
    if (url.origin !== this.base.origin) throw new Error("path escaped the Coolify base origin"); // defence-in-depth
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
        req.destroy(new Error("Coolify request exceeded the time limit"));
      }, DEADLINE_MS);

      const req = doRequest(
        url,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
          lookup: guardedLookup,
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            return done(() => reject(new Error(`Coolify returned a redirect (${status}) — refused by the SSRF guard`)));
          }
          const chunks: Buffer[] = [];
          let len = 0;
          res.on("data", (c: Buffer) => {
            len += c.length;
            if (len > MAX_BYTES) {
              req.destroy();
              done(() => reject(new Error("Coolify response too large")));
              return;
            }
            chunks.push(c);
          });
          res.on("aborted", () => done(() => reject(new Error("Coolify response was truncated"))));
          res.on("end", () =>
            done(() => {
              if (status < 200 || status >= 300) {
                // 401 = no/invalid token; 403 = valid token but not authorized — in Coolify that is
                // almost always the token's ability/team (servers are a root-team resource) or the
                // instance's API "Allowed IPs" setting excluding this hub's address.
                const hint =
                  status === 401
                    ? " (check the API token)"
                    : status === 403
                      ? " (token valid but not authorized — check its ability/team is admin and Coolify's API \"Allowed IPs\" setting allows this hub)"
                      : "";
                return reject(new Error(`Coolify API error ${status}${hint}`));
              }
              const body = Buffer.concat(chunks).toString("utf8");
              try {
                resolve(JSON.parse(body) as T);
              } catch {
                reject(new Error("Coolify returned a non-JSON response — is the URL a Coolify API root?"));
              }
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("Coolify request timed out")));
      req.on("error", (e) => done(() => reject(e)));
      req.end();
    });
  }
}
