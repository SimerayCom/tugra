import { GuardedHttpGet, type RawTransport } from "./guarded-get";
import type { CaproverClient } from "./caprover.source";

/** CapRover wraps every answer as `{ status, description, data }`; 100 = ok, 101/102 = ok with a note. */
interface Envelope {
  status?: unknown;
  data?: unknown;
}

/** Envelope statuses for "not logged in / wrong password / token expired" (the HTTP status is 200 or 401 depending on the call). */
const AUTH_STATUSES = new Set([1102, 1105, 1106]);

const AUTH_HINT = " (check the dashboard password; connect again if the login has expired)";
const hint = (status: number): string =>
  status === 401 || status === 403 ? AUTH_HINT : status === 429 ? " (rate limited, wait a minute and try again)" : "";

/** Read the envelope: the `data` on success, otherwise an error that carries the status and never the password or token. */
function unwrap<T>(body: unknown): T {
  const env = body && typeof body === "object" ? (body as Envelope) : undefined;
  if (!env || typeof env.status !== "number") throw new Error("CapRover returned an unexpected response: use the dashboard address (the /api path is added for you)");
  if (env.status >= 100 && env.status < 200) return env.data as T;
  if (AUTH_STATUSES.has(env.status)) throw new Error(`CapRover API error 401${AUTH_HINT}`);
  throw new Error(`CapRover API error 400 (CapRover status ${env.status})`);
}

function guard(baseUrl: string, token?: string, transport?: RawTransport): GuardedHttpGet {
  return new GuardedHttpGet(baseUrl, {
    apiPrefix: "/api",
    label: "CapRover",
    // `x-namespace: captain` selects the dashboard's own namespace; the login token travels in `x-captain-auth`.
    headers: () => ({ "x-namespace": "captain", ...(token ? { "x-captain-auth": token } : {}) }),
    errorHint: hint,
    transport,
  });
}

/**
 * SSRF-safe client for one CapRover instance, authenticated with a login token. A thin wrapper over the shared
 * {@link GuardedHttpGet} core: CapRover answers 200 with an error envelope for a bad token, so the envelope is checked too.
 */
export class CaproverHttpClient implements CaproverClient {
  private readonly http: GuardedHttpGet;

  /** `transport` is a test seam; the live client always uses the SSRF-pinned one. */
  constructor(baseUrl: string, token: string, transport?: RawTransport) {
    this.http = guard(baseUrl, token, transport);
  }

  async get<T>(path: string): Promise<T> {
    return unwrap<T>(await this.http.get<unknown>(path));
  }
}

/**
 * Exchange the dashboard password for a login token (`POST /api/v2/login`). The password goes into the request body
 * once and is not kept: callers store the returned token only. Errors never include the password.
 */
export async function caproverLogin(baseUrl: string, password: string, transport?: RawTransport): Promise<string> {
  const data = unwrap<{ token?: unknown } | null>(await guard(baseUrl, undefined, transport).postJson<unknown>("/v2/login", { password }));
  const token = data && typeof data.token === "string" ? data.token : "";
  if (!token) throw new Error("CapRover did not return a login token");
  return token;
}
