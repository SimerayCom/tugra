import { Injectable } from "@nestjs/common";
import type { CloudProvider, CloudServerCreateOpts, CloudServerCreateResult } from "./cloud-provider.interface";

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";
const HETZNER_TIMEOUT_MS = 20_000;

/** A Hetzner Cloud API failure. `status` 0 = network/timeout (request never completed). */
export class HetznerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hetznerError?: unknown,
  ) {
    super(message);
    this.name = "HetznerApiError";
  }
}

interface HetznerServer {
  id: number | string;
  public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null } | null;
  // root_password may be present when no SSH key is supplied — intentionally never read.
}

/**
 * Thin, injectable Hetzner Cloud API client (mirrors CloudflareApiClient). The token is passed to
 * every method explicitly (never stored on `this`) and is never interpolated into a thrown/logged
 * message — a leaked exception must not reveal the credential from the Authorization header.
 */
@Injectable()
export class HetznerApiClient implements CloudProvider {
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
      } catch {
        // Network/timeout: never surface the token that lived in the request headers.
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
