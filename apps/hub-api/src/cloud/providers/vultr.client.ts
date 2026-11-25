import { Injectable } from "@nestjs/common";
import type { CloudPriceReader, CloudProvider, CloudServerCreateOpts, CloudServerCreateResult, ProviderServerPlan } from "./cloud-provider.interface";
import { PriceReadGuard } from "./price-read-guard";
import { vultrOsId, vultrPlan, vultrRegion } from "../vultr-catalog";

const VULTR_API_BASE = "https://api.vultr.com/v2"; // fixed host — never user-supplied
const VULTR_TIMEOUT_MS = 20_000;
/** Read-only price reads: page size and pages per list (bounded), cache lifetimes, spacing between requests. */
const VULTR_LIST_PER_PAGE = 500;
const VULTR_LIST_MAX_PAGES = 5;
const VULTR_PRICE_TTL_MS = 5 * 60_000;
const VULTR_PLANS_TTL_MS = 60 * 60_000;
const VULTR_REQUEST_GAP_MS = 250;

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
export class VultrApiClient implements CloudProvider, CloudPriceReader {
  readonly name = "vultr";
  private readonly reads = new PriceReadGuard(VULTR_PRICE_TTL_MS, VULTR_REQUEST_GAP_MS);

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

  /**
   * GET /instances (bounded cursor pages) read as plan + monthly price, USD: the price is the plan's monthly cost from
   * GET /plans, at the instance's region when the plan is priced differently there. Read-only, paced, cached.
   */
  listServerPlans(token: string): Promise<ProviderServerPlan[]> {
    return this.reads.cached(PriceReadGuard.key("vultr-plans", token), async () => {
      const instances: VultrListedInstance[] = [];
      let cursor = "";
      for (let page = 1; page <= VULTR_LIST_MAX_PAGES; page++) {
        await this.reads.pace();
        const res = await this.request<{ instances?: VultrListedInstance[]; meta?: { links?: { next?: string } } }>(
          "GET",
          `/instances?per_page=${VULTR_LIST_PER_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          token,
        );
        for (const i of res?.instances ?? []) if (typeof i?.id === "string" && i.id) instances.push(i);
        cursor = res?.meta?.links?.next ?? "";
        if (!cursor) break;
      }
      if (!instances.length) return [];
      const plans = await this.planList(token);
      const out: ProviderServerPlan[] = [];
      for (const i of instances) {
        const slug = typeof i.plan === "string" ? i.plan : "";
        if (!/^[a-z0-9.-]{1,64}$/.test(slug)) continue;
        const plan = plans.get(slug);
        const region = typeof i.region === "string" ? i.region : null;
        const monthly = plan ? (plan.regionMonthly.get(region ?? "") ?? plan.monthly) : null;
        out.push({
          providerServerId: i.id as string,
          plan: {
            slug,
            cores: plan?.cores ?? finiteNum(i.vcpu_count) ?? 0,
            memoryGb: (plan?.ramMb ?? finiteNum(i.ram) ?? 0) / 1024,
            diskGb: plan?.diskGb ?? finiteNum(i.disk) ?? 0,
            architecture: "x86",
          },
          location: region,
          monthlyCents: monthly === null ? null : Math.round(monthly * 100),
          currency: "USD",
        });
      }
      return out;
    });
  }

  /** GET /plans?type=all (bounded cursor pages): the public plan list with prices, cached for an hour. */
  private planList(token: string): Promise<Map<string, VultrPlanPrice>> {
    return this.reads.cached(
      PriceReadGuard.key("vultr-catalog", token),
      async () => {
        const out = new Map<string, VultrPlanPrice>();
        let cursor = "";
        for (let page = 1; page <= VULTR_LIST_MAX_PAGES; page++) {
          await this.reads.pace();
          const res = await this.request<{ plans?: unknown[]; meta?: { links?: { next?: string } } }>(
            "GET",
            `/plans?type=all&per_page=${VULTR_LIST_PER_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            token,
          );
          for (const raw of res?.plans ?? []) {
            const pl = toVultrPlan(raw);
            if (pl) out.set(pl.id, pl);
          }
          cursor = res?.meta?.links?.next ?? "";
          if (!cursor) break;
        }
        return out;
      },
      VULTR_PLANS_TTL_MS,
    );
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

interface VultrListedInstance {
  id?: unknown;
  plan?: unknown;
  region?: unknown;
  vcpu_count?: unknown;
  ram?: unknown;
  disk?: unknown;
}

interface VultrPlanPrice {
  id: string;
  cores: number | null;
  ramMb: number | null;
  diskGb: number | null;
  /** USD per month. */
  monthly: number;
  /** USD per month at the regions that price the plan differently. */
  regionMonthly: Map<string, number>;
}

const finiteNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** A Vultr plan as far as it is well-formed; null without an id and a monthly cost. */
function toVultrPlan(raw: unknown): VultrPlanPrice | null {
  const o = raw as { id?: unknown; vcpu_count?: unknown; ram?: unknown; disk?: unknown; monthly_cost?: unknown; location_cost?: unknown } | null | undefined;
  const monthly = finiteNum(o?.monthly_cost);
  if (!o || typeof o.id !== "string" || !o.id || monthly === null) return null;
  const regionMonthly = new Map<string, number>();
  if (o.location_cost && typeof o.location_cost === "object") {
    for (const [region, v] of Object.entries(o.location_cost as Record<string, unknown>)) {
      const m = finiteNum((v as { monthly_cost?: unknown } | null)?.monthly_cost);
      if (m !== null) regionMonthly.set(region, m);
    }
  }
  return { id: o.id, cores: finiteNum(o.vcpu_count), ramMb: finiteNum(o.ram), diskGb: finiteNum(o.disk), monthly, regionMonthly };
}

const assigned = (v: string | null | undefined): boolean => typeof v === "string" && v.length > 0;

/** Defence in depth: a provider error body is response-derived, but scrub the token if it is ever echoed. */
function redact(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}
