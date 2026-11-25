import { Injectable } from "@nestjs/common";
import type { CloudPriceReader, CloudProvider, CloudServerCreateOpts, CloudServerCreateResult, ProviderServerPlan } from "./cloud-provider.interface";
import { PriceReadGuard } from "./price-read-guard";
import { digitalOceanImage, digitalOceanRegion, digitalOceanSize } from "../digitalocean-catalog";

const DO_API_BASE = "https://api.digitalocean.com/v2"; // fixed host — never user-supplied
const DO_TIMEOUT_MS = 20_000;
/** Read-only price reads: pages per list (bounded), cache lifetime of a credential's reads, spacing between requests. */
const DO_LIST_PER_PAGE = 200;
const DO_LIST_MAX_PAGES = 5;
const DO_PRICE_TTL_MS = 5 * 60_000;
const DO_SIZES_TTL_MS = 60 * 60_000;
const DO_REQUEST_GAP_MS = 250;

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
export class DigitalOceanApiClient implements CloudProvider, CloudPriceReader {
  readonly name = "digitalocean";
  private readonly reads = new PriceReadGuard(DO_PRICE_TTL_MS, DO_REQUEST_GAP_MS);

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

  /**
   * GET /droplets (bounded pages) read as plan + monthly price, USD. The price comes from the droplet's own `size`
   * object, else from the size list (GET /sizes). Read-only, paced and cached for five minutes per credential.
   */
  listServerPlans(token: string): Promise<ProviderServerPlan[]> {
    return this.reads.cached(PriceReadGuard.key("do-plans", token), async () => {
      const droplets: DoDropletSize[] = [];
      for (let page = 1; page <= DO_LIST_MAX_PAGES; page++) {
        await this.reads.pace();
        const res = await this.request<{ droplets?: DoDropletSize[]; links?: { pages?: { next?: string } } }>("GET", `/droplets?per_page=${DO_LIST_PER_PAGE}&page=${page}`, token);
        for (const d of res?.droplets ?? []) if (d?.id !== undefined && d.id !== null) droplets.push(d);
        if (!res?.links?.pages?.next) break;
      }
      // The size list is only read when a droplet does not carry its own size.
      let sizes: Map<string, DoSize> | null = null;
      const out: ProviderServerPlan[] = [];
      for (const d of droplets) {
        let size = toDoSize(d.size) ?? toDoSize({ slug: d.size_slug });
        if (!size || size.priceMonthly === null) {
          sizes ??= await this.sizeList(token);
          const slug = size?.slug ?? (typeof d.size_slug === "string" ? d.size_slug : "");
          size = sizes.get(slug) ?? size;
        }
        if (!size || !/^[a-z0-9.-]{1,64}$/.test(size.slug)) continue;
        out.push({
          providerServerId: String(d.id),
          plan: { slug: size.slug, cores: size.vcpus ?? 0, memoryGb: size.memoryMb ? size.memoryMb / 1024 : 0, diskGb: size.diskGb ?? 0, architecture: "x86" },
          location: typeof d.region?.slug === "string" ? d.region.slug : null,
          monthlyCents: size.priceMonthly === null ? null : Math.round(size.priceMonthly * 100),
          currency: "USD",
        });
      }
      return out;
    });
  }

  /** GET /sizes (bounded pages), cached for an hour per credential. */
  private sizeList(token: string): Promise<Map<string, DoSize>> {
    return this.reads.cached(PriceReadGuard.key("do-sizes", token), async () => {
      const out = new Map<string, DoSize>();
      for (let page = 1; page <= DO_LIST_MAX_PAGES; page++) {
        await this.reads.pace();
        const res = await this.request<{ sizes?: unknown[]; links?: { pages?: { next?: string } } }>("GET", `/sizes?per_page=${DO_LIST_PER_PAGE}&page=${page}`, token);
        for (const raw of res?.sizes ?? []) {
          const sz = toDoSize(raw);
          if (sz) out.set(sz.slug, sz);
        }
        if (!res?.links?.pages?.next) break;
      }
      return out;
    }, DO_SIZES_TTL_MS);
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

interface DoDropletSize {
  id: number | string;
  size_slug?: unknown;
  size?: unknown;
  region?: { slug?: unknown } | null;
}

interface DoSize {
  slug: string;
  vcpus: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  /** USD per month, or null when the API gave none. */
  priceMonthly: number | null;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** A DigitalOcean size object as far as it is well-formed; null when it has no usable slug. */
function toDoSize(raw: unknown): DoSize | null {
  const o = raw as { slug?: unknown; vcpus?: unknown; memory?: unknown; disk?: unknown; price_monthly?: unknown } | null | undefined;
  if (!o || typeof o.slug !== "string" || !o.slug) return null;
  return { slug: o.slug, vcpus: finite(o.vcpus), memoryMb: finite(o.memory), diskGb: finite(o.disk), priceMonthly: finite(o.price_monthly) };
}

function publicAddress(list: Array<{ ip_address?: string; type?: string }> | null | undefined): string | null {
  return list?.find((n) => n.type === "public" && n.ip_address)?.ip_address ?? null;
}

/** Defence in depth: a provider error body is response-derived, but scrub the token if it is ever echoed. */
function redact(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}
