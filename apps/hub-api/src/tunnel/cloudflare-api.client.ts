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

/** A Cloudflare DNS record (the fields the one-click domain auto-setup needs). */
export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

/**
 * Thin, injectable Cloudflare API v4 client. Every method takes the operator API
 * token EXPLICITLY (it is never stored on the instance) and the client never
 * interpolates the token into a thrown/logged message — a leaked exception must
 * not reveal the credential that lived in the request headers.
 */
@Injectable()
export class CloudflareApiClient {
  /** Verify an API token resolves to an active token. Tries GET /user/tokens/verify (user-owned tokens — the
   *  common case); if that is rejected (401/403) and an `accountId` is supplied, retries
   *  GET /accounts/{accountId}/tokens/verify (account-owned tokens verify there, not at /user). An invalid
   *  token → valid:false, not a throw. */
  async verifyToken(apiToken: string, accountId?: string): Promise<{ valid: boolean }> {
    try {
      const r = await this.request<{ status?: string }>("GET", "/user/tokens/verify", apiToken);
      return { valid: r?.status === "active" };
    } catch (e) {
      if (e instanceof CloudflareApiError && (e.status === 401 || e.status === 403)) {
        if (accountId) return this.verifyAccountToken(apiToken, accountId);
        return { valid: false };
      }
      throw e;
    }
  }

  /** GET /accounts/{accountId}/tokens/verify → { valid }. An invalid/inaccessible token (401/403/404) →
   *  valid:false, not a throw. */
  private async verifyAccountToken(apiToken: string, accountId: string): Promise<{ valid: boolean }> {
    try {
      const r = await this.request<{ status?: string }>(
        "GET",
        `/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
        apiToken,
      );
      return { valid: r?.status === "active" };
    } catch (e) {
      if (e instanceof CloudflareApiError && (e.status === 401 || e.status === 403 || e.status === 404)) return { valid: false };
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

  /** Find the zone whose name is the LONGEST suffix of `hostname` (e.g. `app.foo.co.uk` → `foo.co.uk`). Lists
   *  the token's accessible zones (up to 50 — a scoped token has few) and picks the longest match. Throws 404
   *  when none matches (the token can't see the zone). This is the hostname→zone resolver the auto-setup needs,
   *  unlike findZoneId which requires the exact zone name. */
  async findZoneForHostname(apiToken: string, hostname: string): Promise<{ zoneId: string; zoneName: string }> {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    const zones = await this.request<Array<{ id: string; name: string }>>("GET", "/zones?per_page=50", apiToken);
    const match = zones
      .filter((z) => z.name && (host === z.name || host.endsWith(`.${z.name}`)))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!match?.id) {
      throw new CloudflareApiError("no accessible Cloudflare zone matches this hostname — add the zone to this API token's scope", 404);
    }
    return { zoneId: match.id, zoneName: match.name };
  }

  /** List a zone's DNS records, optionally filtered by exact name and/or type. */
  async listDnsRecords(apiToken: string, zoneId: string, filter?: { name?: string; type?: string }): Promise<DnsRecord[]> {
    const parts: string[] = [];
    if (filter?.type) parts.push(`type=${encodeURIComponent(filter.type)}`);
    if (filter?.name) parts.push(`name=${encodeURIComponent(filter.name)}`);
    const q = parts.length ? `?${parts.join("&")}` : "";
    return this.request<DnsRecord[]>("GET", `/zones/${encodeURIComponent(zoneId)}/dns_records${q}`, apiToken);
  }

  /** Create or update ANY DNS record by (type, name). Idempotent: with no `existingRecordId` it looks the record
   *  up (so a re-run updates instead of 81057/81058-duplicating), then PUTs; otherwise POSTs a new one. Returns
   *  the record id + whether it was created or updated. `proxied` defaults to false (DNS-only) and `ttl` to auto. */
  async upsertDnsRecord(
    apiToken: string,
    zoneId: string,
    rec: { type: string; name: string; content: string; proxied?: boolean; ttl?: number; existingRecordId?: string | null },
  ): Promise<{ recordId: string; action: "created" | "updated" }> {
    const body = { type: rec.type, name: rec.name, content: rec.content, proxied: rec.proxied ?? false, ttl: rec.ttl ?? 1 };
    let recordId = rec.existingRecordId ?? null;
    if (!recordId) {
      const found = await this.listDnsRecords(apiToken, zoneId, { type: rec.type, name: rec.name });
      recordId = found[0]?.id ?? null;
    }
    if (recordId) {
      await this.request("PUT", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, apiToken, body);
      return { recordId, action: "updated" };
    }
    const created = await this.request<{ id?: string }>("POST", `/zones/${encodeURIComponent(zoneId)}/dns_records`, apiToken, body);
    if (!created?.id) throw new CloudflareApiError("cloudflare did not return a dns record id", 502);
    return { recordId: created.id, action: "created" };
  }

  /** Create a NEW DNS record (pure POST — no find-first). Use this when reconciling a set of records at one name
   *  (e.g. several A records for a multi-node cluster ingress) where upsertDnsRecord's "update the first match"
   *  behaviour would wrongly overwrite a sibling instead of adding one. `proxied` defaults to false, `ttl` to auto. */
  async createDnsRecord(
    apiToken: string,
    zoneId: string,
    rec: { type: string; name: string; content: string; proxied?: boolean; ttl?: number },
  ): Promise<{ recordId: string }> {
    const body = { type: rec.type, name: rec.name, content: rec.content, proxied: rec.proxied ?? false, ttl: rec.ttl ?? 1 };
    const created = await this.request<{ id?: string }>("POST", `/zones/${encodeURIComponent(zoneId)}/dns_records`, apiToken, body);
    if (!created?.id) throw new CloudflareApiError("cloudflare did not return a dns record id", 502);
    return { recordId: created.id };
  }

  /** The zone's SSL/TLS encryption mode ("off"|"flexible"|"full"|"strict"). The auto-setup reads this to warn
   *  about the Flexible-SSL + :80→:443-redirect infinite-loop trap before creating proxied records. */
  async getZoneSslMode(apiToken: string, zoneId: string): Promise<string> {
    const r = await this.request<{ value?: string }>("GET", `/zones/${encodeURIComponent(zoneId)}/settings/ssl`, apiToken);
    return r?.value ?? "unknown";
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

  /** Create or update a DNS CNAME → <tunnelId>.cfargotunnel.com (proxied). Idempotent. Thin wrapper over the
   *  generic upsertDnsRecord — same lookup-then-PUT-else-POST behaviour the tunnel flow relies on. */
  async upsertCname(
    apiToken: string,
    zoneId: string,
    opts: { name: string; tunnelId: string; existingRecordId?: string | null },
  ): Promise<{ recordId: string }> {
    const { recordId } = await this.upsertDnsRecord(apiToken, zoneId, {
      type: "CNAME",
      name: opts.name,
      content: `${opts.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      existingRecordId: opts.existingRecordId,
    });
    return { recordId };
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
