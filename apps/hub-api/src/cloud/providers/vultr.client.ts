import { Injectable } from "@nestjs/common";
import type { CloudProvider, CloudServerCreateOpts, CloudServerCreateResult } from "./cloud-provider.interface";
import { vultrOsId, vultrPlan, vultrRegion } from "../vultr-catalog";

const VULTR_API_BASE = "https://api.vultr.com/v2"; // fixed host — never user-supplied
const VULTR_TIMEOUT_MS = 20_000;

/** A Vultr API failure. `status` 0 = network/timeout; 400 from a curated-key miss. */
export class VultrApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VultrApiError";
  }
}

interface VultrInstance {
  id?: string;
  main_ip?: string | null; // "0.0.0.0" until the instance is assigned an address
  v6_main_ip?: string | null; // "" until assigned
}

/**
 * Thin, injectable Vultr API client. The token is passed to every method explicitly (never stored
 * on `this`) and is never interpolated into a thrown/logged message — a leaked exception must not
 * reveal the credential from the Authorization header.
 */
@Injectable()
export class VultrApiClient implements CloudProvider {
  readonly name = "vultr";

  /** GET /account — 200 → valid; 401/403 → invalid (not a throw). */
  async verifyToken(token: string): Promise<{ valid: boolean }> {
    try {
      await this.request("GET", "/account", token);
      return { valid: true };
    } catch (e) {
      if (e instanceof VultrApiError && (e.status === 401 || e.status === 403)) return { valid: false };
      throw e;
    }
  }

  /** POST /instances — create + boot an instance running the (base64-encoded) cloud-init user-data. */
  async createServer(token: string, opts: CloudServerCreateOpts): Promise<CloudServerCreateResult> {
    const region = vultrRegion(opts.location);
    if (!region) throw new VultrApiError("unknown vultr location", 400);
    const plan = vultrPlan(opts.serverType);
    if (!plan) throw new VultrApiError("unknown vultr server type", 400);
    const osId = vultrOsId(opts.image);
    if (osId === undefined) throw new VultrApiError("unknown vultr image", 400);

    const res = await this.request<{ instance?: VultrInstance }>("POST", "/instances", token, {
      label: opts.name,
      hostname: opts.name,
      region,
      plan,
      os_id: osId,
      user_data: Buffer.from(opts.userData, "utf8").toString("base64"), // Vultr requires base64
      enable_ipv6: true,
      backups: "disabled",
    });
    const instance = res?.instance;
    if (!instance?.id) throw new VultrApiError("vultr did not return an instance id", 502);
    return {
      providerServerId: String(instance.id),
      publicIp: assigned(instance.main_ip) && instance.main_ip !== "0.0.0.0" ? (instance.main_ip as string) : null,
      publicIpv6: assigned(instance.v6_main_ip) ? (instance.v6_main_ip as string) : null,
    };
  }

  /** DELETE /instances/{id}; an already-gone (404) instance resolves normally (idempotent teardown). */
  async destroyServer(token: string, providerServerId: string): Promise<void> {
    try {
      await this.request("DELETE", `/instances/${encodeURIComponent(providerServerId)}`, token);
    } catch (e) {
      if (e instanceof VultrApiError && e.status === 404) return;
      throw e;
    }
  }

  private async request<T = unknown>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VULTR_TIMEOUT_MS);
    try {
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${VULTR_API_BASE}${path}`, {
          method,
          signal: ctrl.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        // Network/timeout: never surface the token that lived in the request headers.
        throw new VultrApiError("vultr api unreachable", 0);
      }
      if (res.status === 204) return undefined as T;
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok) {
        const err = (json as { error?: string } | null)?.error;
        const msg = typeof err === "string" && err ? `vultr: ${redact(err, token)}` : `vultr api error (HTTP ${res.status})`;
        throw new VultrApiError(msg, res.status);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

const assigned = (v: string | null | undefined): boolean => typeof v === "string" && v.length > 0;

/** Defence in depth: a provider error body is response-derived, but scrub the token if it is ever echoed. */
function redact(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}
