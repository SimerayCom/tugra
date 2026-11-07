import { Injectable } from "@nestjs/common";
import type { CloudProvider, CloudServerCreateOpts, CloudServerCreateResult } from "./cloud-provider.interface";
import { digitalOceanImage, digitalOceanRegion, digitalOceanSize } from "../digitalocean-catalog";

const DO_API_BASE = "https://api.digitalocean.com/v2"; // fixed host — never user-supplied
const DO_TIMEOUT_MS = 20_000;

/** A DigitalOcean API failure. `status` 0 = network/timeout; 400 from a curated-key miss. */
export class DigitalOceanApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly doError?: unknown,
  ) {
    super(message);
    this.name = "DigitalOceanApiError";
  }
}

interface DoDroplet {
  id: number | string;
  networks?: {
    v4?: Array<{ ip_address?: string; type?: string }> | null;
    v6?: Array<{ ip_address?: string; type?: string }> | null;
  } | null;
}

/**
 * Thin, injectable DigitalOcean API client. The token is passed to every method explicitly (never
 * stored on `this`) and is never interpolated into a thrown/logged message — a leaked exception must
 * not reveal the credential from the Authorization header.
 */
@Injectable()
export class DigitalOceanApiClient implements CloudProvider {
  readonly name = "digitalocean";

  /** GET /account — 200 → valid; 401/403 → invalid (not a throw). */
  async verifyToken(token: string): Promise<{ valid: boolean }> {
    try {
      await this.request("GET", "/account", token);
      return { valid: true };
    } catch (e) {
      if (e instanceof DigitalOceanApiError && (e.status === 401 || e.status === 403)) return { valid: false };
      throw e;
    }
  }

  /** POST /droplets — create + boot a droplet running the given cloud-init user-data. */
  async createServer(token: string, opts: CloudServerCreateOpts): Promise<CloudServerCreateResult> {
    const region = digitalOceanRegion(opts.location);
    if (!region) throw new DigitalOceanApiError("unknown digitalocean location", 400);
    const size = digitalOceanSize(opts.serverType);
    if (!size) throw new DigitalOceanApiError("unknown digitalocean server type", 400);
    const image = digitalOceanImage(opts.image);
    if (!image) throw new DigitalOceanApiError("unknown digitalocean image", 400);

    const res = await this.request<{ droplet?: DoDroplet }>("POST", "/droplets", token, {
      name: opts.name,
      region,
      size,
      image,
      user_data: opts.userData,
      ipv6: true,
      monitoring: false,
      // no ssh_keys — access is only ever via the Tugra agent
    });
    const droplet = res?.droplet;
    if (!droplet?.id) throw new DigitalOceanApiError("digitalocean did not return a droplet id", 502);
    // networks is usually empty right after create (the droplet is still booting) → null; the
    // agent's own enroll reports the observed IP.
    return {
      providerServerId: String(droplet.id),
      publicIp: publicAddress(droplet.networks?.v4),
      publicIpv6: publicAddress(droplet.networks?.v6),
    };
  }

  /** DELETE /droplets/{id}; an already-gone (404) droplet resolves normally (idempotent teardown). */
  async destroyServer(token: string, providerServerId: string): Promise<void> {
    try {
      await this.request("DELETE", `/droplets/${encodeURIComponent(providerServerId)}`, token);
    } catch (e) {
      if (e instanceof DigitalOceanApiError && e.status === 404) return;
      throw e;
    }
  }

  private async request<T = unknown>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DO_TIMEOUT_MS);
    try {
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${DO_API_BASE}${path}`, {
          method,
          signal: ctrl.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        // Network/timeout: never surface the token that lived in the request headers.
        throw new DigitalOceanApiError("digitalocean api unreachable", 0);
      }
      if (res.status === 204) return undefined as T;
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok) {
        const err = json as { id?: string; message?: string } | null;
        const msg = err?.message ? `digitalocean: ${redact(err.message, token)}` : `digitalocean api error (HTTP ${res.status})`;
        throw new DigitalOceanApiError(msg, res.status, err ? { id: err.id } : undefined);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function publicAddress(list: Array<{ ip_address?: string; type?: string }> | null | undefined): string | null {
  return list?.find((n) => n.type === "public" && n.ip_address)?.ip_address ?? null;
}

/** Defence in depth: a provider error body is response-derived, but scrub the token if it is ever echoed. */
function redact(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}
