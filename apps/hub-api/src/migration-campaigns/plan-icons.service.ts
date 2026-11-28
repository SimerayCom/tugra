import { Injectable } from "@nestjs/common";
import { cleanHost, findFavicon, FAVICON_MAX_BYTES, realFaviconTransport, sniffImage, type FaviconTransport, type FoundFavicon } from "../applications/favicon-fetcher";

const HIT_TTL_MS = 7 * 24 * 3600_000;
const MISS_TTL_MS = 3600_000;
const CACHE_MAX = 500;
const MAX_PARALLEL = 4;
/** A GitHub login: letters, digits and single hyphens, 1-39 long. */
const GITHUB_OWNER = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const AVATAR_HOST = "avatars.githubusercontent.com";

export type PlanIconKind = "site" | "github";

/**
 * The icons of the apps a move PLAN lists, before any Tugra app exists to hang a favicon on: a site's favicon, or the avatar of the GitHub owner of the
 * app's repository. The browser never contacts either site: the hub fetches (public addresses only, size capped, raster images only, the same
 * guards as an app's favicon) and keeps the answer in memory for a while. Only a plain DNS name or a GitHub login can be asked for, nothing else.
 */
@Injectable()
export class PlanIconService {
  private readonly cache = new Map<string, { at: number; icon: FoundFavicon | null }>();
  private readonly inflight = new Map<string, Promise<FoundFavicon | null>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  /** Seams for tests; the defaults are the real fetch, transport and clock. */
  fetchSite: typeof findFavicon = findFavicon;
  transport: FaviconTransport = realFaviconTransport;
  now: () => number = Date.now;

  async get(kind: PlanIconKind, name: string): Promise<FoundFavicon | null> {
    const key = kind === "site" ? cleanHost(name) : GITHUB_OWNER.test(name) ? name.toLowerCase() : null;
    if (!key) return null;
    const id = `${kind}:${key}`;
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < (hit.icon ? HIT_TTL_MS : MISS_TTL_MS)) return hit.icon;
    const pending = this.inflight.get(id);
    if (pending) return pending;
    const job = this.refresh(id, kind, key).finally(() => this.inflight.delete(id));
    this.inflight.set(id, job);
    return job;
  }

  private async refresh(id: string, kind: PlanIconKind, key: string): Promise<FoundFavicon | null> {
    await this.slot();
    try {
      let icon: FoundFavicon | null = null;
      try {
        icon = kind === "site" ? await this.fetchSite([key]) : await this.avatar(key);
      } catch {
        icon = null; // a site that does not answer has no icon for us, and is not asked again at once
      }
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(id, { at: this.now(), icon });
      return icon;
    } finally {
      this.release();
    }
  }

  /** `github.com/<owner>.png` answers with one redirect to GitHub's avatar host; nothing else is followed. */
  private async avatar(owner: string): Promise<FoundFavicon | null> {
    let res = await this.transport({ scheme: "https", host: "github.com", path: `/${owner}.png?size=64` });
    if (res.status >= 300 && res.status < 400 && res.location) {
      let next: URL;
      try {
        next = new URL(res.location, "https://github.com/");
      } catch {
        return null;
      }
      if (next.protocol !== "https:" || next.hostname.toLowerCase() !== AVATAR_HOST || next.port || next.username || next.password) return null;
      res = await this.transport({ scheme: "https", host: AVATAR_HOST, path: next.pathname + next.search });
    }
    if (res.status !== 200 || !res.contentType || !/^image\//i.test(res.contentType)) return null;
    if (res.body.length === 0 || res.body.length > FAVICON_MAX_BYTES) return null;
    const mime = sniffImage(res.body);
    return mime ? { mime, data: res.body } : null;
  }

  private slot(): Promise<void> {
    if (this.running < MAX_PARALLEL) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => { this.running++; resolve(); }));
  }

  private release(): void {
    this.running--;
    this.waiting.shift()?.();
  }
}
