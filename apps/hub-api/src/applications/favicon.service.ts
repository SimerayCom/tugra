import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { cleanHost, findFavicon, type FoundFavicon } from "./favicon-fetcher";

/** A found icon stays 7 days; a site with none is asked again after a day. */
export const FAVICON_TTL_MS = 7 * 24 * 3600_000;
export const FAVICON_MISS_TTL_MS = 24 * 3600_000;
const MAX_PARALLEL = 4;

export interface FaviconTarget {
  id: string;
  domain: string | null;
  extraDomains: string[];
}

/**
 * Favicon of an app's own domain, fetched by the hub and cached in the database (the browser never contacts the
 * site). The hostnames come from the app's own configuration, never from the request.
 */
@Injectable()
export class FaviconService {
  private readonly inflight = new Map<string, Promise<FoundFavicon | null>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  /** Seams for tests; the defaults are the real fetch and clock. */
  fetchIcon: typeof findFavicon = findFavicon;
  now: () => number = Date.now;

  constructor(private readonly prisma: PrismaService) {}

  /** The cached or freshly fetched favicon, or null when the app has no usable domain or its site has none. */
  async get(app: FaviconTarget): Promise<FoundFavicon | null> {
    const host = cleanHost(app.domain);
    if (!host) return null;
    const row = await this.prisma.appFavicon.findUnique({ where: { appId: app.id } });
    if (row && row.domain === host) {
      const age = this.now() - row.fetchedAt.getTime();
      if (row.data && age < FAVICON_TTL_MS) return { mime: row.mime ?? "image/x-icon", data: Buffer.from(row.data) };
      if (!row.data && age < FAVICON_MISS_TTL_MS) return null;
    }
    const pending = this.inflight.get(app.id);
    if (pending) return pending;
    const job = this.refresh(app, host).finally(() => this.inflight.delete(app.id));
    this.inflight.set(app.id, job);
    return job;
  }

  private async refresh(app: FaviconTarget, host: string): Promise<FoundFavicon | null> {
    await this.slot();
    try {
      const found = await this.fetchIcon([host, ...app.extraDomains]);
      const data = found ? Buffer.from(found.data) : null;
      const mime = found ? found.mime : null;
      await this.prisma.appFavicon.upsert({
        where: { appId: app.id },
        create: { appId: app.id, domain: host, mime, data, fetchedAt: new Date(this.now()) },
        update: { domain: host, mime, data, fetchedAt: new Date(this.now()) },
      });
      return found;
    } catch {
      return null; // the cache write failed or the app went away: nothing to show, and nothing to retry loudly
    } finally {
      this.release();
    }
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
