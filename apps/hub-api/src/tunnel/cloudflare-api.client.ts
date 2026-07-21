import { Injectable } from "@nestjs/common";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const CF_TIMEOUT_MS = 15_000;

/** A Cloudflare API failure. `status` 0 = network/timeout (request never completed). */
export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly cfErrors?: unknown,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export interface CfTunnelCreateResult {
  tunnelId: string;
  token: string;
}

export interface IngressRule {
  hostname?: string;
  service: string;
}

/**
 * Thin, injectable Cloudflare API v4 client. Every method takes the operator API
 * token EXPLICITLY (it is never stored on the instance) and the client never
 * interpolates the token into a thrown/logged message — a leaked exception must
 * not reveal the credential that lived in the request headers.
 */
@Injectable()
export class CloudflareApiClient {
  /** GET /user/tokens/verify → { valid }. An invalid token (401/403) → valid:false, not a throw. */
  async verifyToken(apiToken: string): Promise<{ valid: boolean }> {
    try {
      const r = await this.request<{ status?: string }>("GET", "/user/tokens/verify", apiToken);
      return { valid: r?.status === "active" };
    } catch (e) {
      if (e instanceof CloudflareApiError && (e.status === 401 || e.status === 403)) return { valid: false };
      throw e;
    }
  }

  /** GET /zones?name=<zoneName> → the matching zone id (throws 404 when none is accessible). */
  async findZoneId(apiToken: string, zoneName: string): Promise<string> {
    const zones = await this.request<Array<{ id: string; name: string }>>(
      "GET",
      `/zones?name=${encodeURIComponent(zoneName)}`,
      apiToken,
    );
    const zone = zones.find((z) => z.name === zoneName) ?? zones[0];
    if (!zone?.id) throw new CloudflareApiError("zone not found or not accessible by this token", 404);
    return zone.id;
  }

  /** POST /accounts/{account}/cfd_tunnel (remotely-managed) → { tunnelId, token }. */
  async createTunnel(apiToken: string, accountId: string, name: string): Promise<CfTunnelCreateResult> {
    const res = await this.request<{ id?: string; token?: string }>(
      "POST",
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
      apiToken,
      { name, config_src: "cloudflare" },
    );
    if (!res?.id || !res.token) throw new CloudflareApiError("cloudflare did not return a tunnel id/token", 502);
    return { tunnelId: res.id, token: res.token };
  }

  /** GET the tunnel's current ingress rules ([] when unset). */
  async getIngressConfig(apiToken: string, accountId: string, tunnelId: string): Promise<IngressRule[]> {
    const res = await this.request<{ config?: { ingress?: IngressRule[] } }>(
      "GET",
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      apiToken,
    );
    return res?.config?.ingress ?? [];
  }

  /** PUT the tunnel's ingress rules. A catch-all 404 rule is always appended last (cloudflared requires it). */
  async putIngressConfig(apiToken: string, accountId: string, tunnelId: string, ingress: IngressRule[]): Promise<void> {
    await this.request(
      "PUT",
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      apiToken,
      { config: { ingress: withCatchAll(ingress) } },
    );
  }

  /** Create or update a DNS CNAME → <tunnelId>.cfargotunnel.com (proxied). Idempotent. */
  async upsertCname(
    apiToken: string,
    zoneId: string,
    opts: { name: string; tunnelId: string; existingRecordId?: string | null },
  ): Promise<{ recordId: string }> {
    const body = {
      type: "CNAME",
      name: opts.name,
      content: `${opts.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    };
    let recordId = opts.existingRecordId ?? null;
    if (!recordId) {
      // Look up any existing record so a re-run updates it instead of 81057/81058 (duplicate).
      const found = await this.request<Array<{ id: string }>>(
        "GET",
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(opts.name)}`,
        apiToken,
      );
      recordId = found[0]?.id ?? null;
    }
    if (recordId) {
      await this.request(
        "PUT",
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        apiToken,
        body,
      );
      return { recordId };
    }
    const created = await this.request<{ id?: string }>(
      "POST",
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      apiToken,
      body,
    );
    if (!created?.id) throw new CloudflareApiError("cloudflare did not return a dns record id", 502);
    return { recordId: created.id };
  }

  /** DELETE a DNS record; an already-gone (404) resource resolves normally (idempotent teardown). */
  async deleteDnsRecord(apiToken: string, zoneId: string, recordId: string): Promise<void> {
    await this.deleteTolerant(
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      apiToken,
    );
  }

  /** DELETE a tunnel; an already-gone (404) resource resolves normally (idempotent teardown). */
  async deleteTunnel(apiToken: string, accountId: string, tunnelId: string): Promise<void> {
    await this.deleteTolerant(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
      apiToken,
    );
  }

  private async deleteTolerant(path: string, apiToken: string): Promise<void> {
    try {
      await this.request("DELETE", path, apiToken);
    } catch (e) {
      if (e instanceof CloudflareApiError && e.status === 404) return;
      throw e;
    }
  }

  private async request<T = unknown>(method: string, path: string, apiToken: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CF_TIMEOUT_MS);
    try {
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${CF_API_BASE}${path}`, {
          method,
          signal: ctrl.signal,
          headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        // Network/timeout: never surface the token that lived in the request headers.
        throw new CloudflareApiError("cloudflare api unreachable", 0);
      }
      type Envelope = { success?: boolean; errors?: unknown; result?: T };
      let json: Envelope | null = null;
      try {
        json = (await res.json()) as Envelope;
      } catch {
        json = null;
      }
      if (!res.ok || !json || json.success === false) {
        const msg = cfErrorMessage(json?.errors) ?? `cloudflare api error (HTTP ${res.status})`;
        throw new CloudflareApiError(msg, res.status, json?.errors);
      }
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** cloudflared requires the final ingress rule to be a hostname-less catch-all. */
function withCatchAll(ingress: IngressRule[]): IngressRule[] {
  const rules = ingress.filter((r) => r.hostname); // drop any stray/duplicate catch-alls
  return [...rules, { service: "http_status:404" }];
}

/** CF errors come from the RESPONSE (never the token) so this message is safe to surface. */
function cfErrorMessage(errors: unknown): string | null {
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: string };
    if (first?.message) return `cloudflare: ${first.message}`;
  }
  return null;
}
