import { Injectable } from "@nestjs/common";

const VAULT_TIMEOUT_MS = 15_000;

/** A Vault API failure. `status` 0 = network/timeout (the request never completed). The token is NEVER
 *  interpolated into the message — a leaked exception must not reveal the credential from the request. */
export class VaultApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VaultApiError";
  }
}

/** A Vault KV-v2 locator parsed from a SecretRef.remoteKey of the form "<mount>/<path>#<field>". */
export interface VaultLocator {
  mount: string;
  path: string;
  field: string;
}

/**
 * Parse a Vault KV-v2 locator "<mount>/<path>#<field>" (e.g. "secret/myapp#DB_PASSWORD" →
 * mount=secret, path=myapp, field=DB_PASSWORD; a nested path like "secret/team/app#KEY" →
 * mount=secret, path=team/app). The field is required (we fetch one value, not a whole secret), and a
 * mount + at least one path segment are required. Throws a non-secret error on a malformed locator.
 */
export function parseVaultLocator(remoteKey: string): VaultLocator {
  const hash = remoteKey.lastIndexOf("#");
  if (hash < 0) {
    throw new VaultApiError(`invalid Vault key "${remoteKey}" — expected "<mount>/<path>#<field>"`, 0);
  }
  const field = remoteKey.slice(hash + 1).trim();
  const locator = remoteKey.slice(0, hash).trim().replace(/^\/+|\/+$/g, "");
  if (!field) throw new VaultApiError(`invalid Vault key "${remoteKey}" — missing field after "#"`, 0);
  const slash = locator.indexOf("/");
  if (slash <= 0 || slash >= locator.length - 1) {
    throw new VaultApiError(`invalid Vault key "${remoteKey}" — expected "<mount>/<path>#<field>"`, 0);
  }
  return { mount: locator.slice(0, slash), path: locator.slice(slash + 1), field };
}

/**
 * Thin, injectable HashiCorp Vault client (KV secrets engine v2). Every call takes the store address and
 * access token EXPLICITLY — neither is stored on the instance — and the token is never written into a
 * thrown message or log line. Used by the deploy env resolver to fetch referenced secrets at deploy time.
 */
@Injectable()
export class VaultApiClient {
  /** True when the token authenticates against the store (GET /v1/auth/token/lookup-self → 200). A rejected
   *  token resolves to valid:false; a network/timeout failure throws (so the caller can distinguish "wrong
   *  token" from "could not reach the store"). */
  async verify(address: string, token: string): Promise<{ valid: boolean }> {
    const r = await this.request(address, "auth/token/lookup-self", token);
    if (r.status === 200) return { valid: true };
    if (r.status === 401 || r.status === 403) return { valid: false };
    throw new VaultApiError(`Vault token verification failed (status ${r.status})`, r.status);
  }

  /** Fetch one secret value by its KV-v2 locator. Throws VaultApiError if the store is unreachable, the
   *  token is rejected, the path is missing, or the field is absent/non-scalar. */
  async fetchSecret(address: string, token: string, remoteKey: string): Promise<string> {
    const loc = parseVaultLocator(remoteKey);
    const r = await this.request(address, `${loc.mount}/data/${loc.path}`, token);
    if (r.status === 404) {
      throw new VaultApiError(`Vault secret not found at "${loc.mount}/${loc.path}"`, 404);
    }
    if (r.status !== 200) {
      throw new VaultApiError(`Vault read failed for "${loc.mount}/${loc.path}" (status ${r.status})`, r.status);
    }
    const data = (r.body as { data?: { data?: Record<string, unknown> } })?.data?.data;
    const value = data ? data[loc.field] : undefined;
    if (value === undefined || value === null) {
      throw new VaultApiError(`Vault secret "${loc.mount}/${loc.path}" has no field "${loc.field}"`, 200);
    }
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    throw new VaultApiError(`Vault field "${loc.field}" at "${loc.mount}/${loc.path}" is not a scalar value`, 200);
  }

  /** One GET to {address}/v1/{apiPath} with the token header, a timeout, and no token in any error text. */
  private async request(
    address: string,
    apiPath: string,
    token: string,
  ): Promise<{ status: number; body: unknown }> {
    const base = address.replace(/\/+$/, "");
    const url = `${base}/v1/${apiPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "X-Vault-Token": token, Accept: "application/json" },
        signal: controller.signal,
      });
      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        body = undefined; // non-JSON (e.g. a 404 html) — status still drives the decision
      }
      return { status: res.status, body };
    } catch {
      // Network error / timeout / abort — never surface the underlying error (it can embed the URL + headers).
      throw new VaultApiError(`could not reach the Vault store at ${base}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }
}
