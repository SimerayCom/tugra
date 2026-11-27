import type { PrismaService } from "../prisma/prisma.service";
import { FaviconService, FAVICON_MISS_TTL_MS, FAVICON_TTL_MS } from "./favicon.service";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const NOW = Date.UTC(2026, 11, 10);

function make(row: unknown, find = jest.fn().mockResolvedValue({ mime: "image/png", data: PNG })) {
  const upsert = jest.fn().mockResolvedValue({});
  const prisma = { appFavicon: { findUnique: jest.fn().mockResolvedValue(row), upsert } } as unknown as PrismaService;
  const svc = new FaviconService(prisma);
  svc.fetchIcon = find as never;
  svc.now = () => NOW;
  return { svc, find, upsert };
}
const target = { id: "a1", domain: "shop.example.com", extraDomains: ["www.shop.example.com"] };

describe("FaviconService", () => {
  it("fetches, stores and returns the icon when nothing is cached", async () => {
    const { svc, find, upsert } = make(null);
    const out = await svc.get(target);
    expect(out?.mime).toBe("image/png");
    expect(find).toHaveBeenCalledWith(["shop.example.com", "www.shop.example.com"]);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { appId: "a1" }, create: expect.objectContaining({ domain: "shop.example.com", mime: "image/png" }) }));
  });

  it("serves a cached icon younger than 7 days without fetching", async () => {
    const { svc, find } = make({ domain: "shop.example.com", mime: "image/png", data: PNG, fetchedAt: new Date(NOW - FAVICON_TTL_MS + 60_000) });
    expect((await svc.get(target))?.data.equals(PNG)).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it("refreshes an icon older than 7 days", async () => {
    const { svc, find } = make({ domain: "shop.example.com", mime: "image/png", data: PNG, fetchedAt: new Date(NOW - FAVICON_TTL_MS - 1000) });
    await svc.get(target);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the domain changed, whatever the age", async () => {
    const { svc, find } = make({ domain: "old.example.com", mime: "image/png", data: PNG, fetchedAt: new Date(NOW - 1000) });
    await svc.get(target);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("remembers a miss for a day, then asks again", async () => {
    const fresh = make({ domain: "shop.example.com", mime: null, data: null, fetchedAt: new Date(NOW - FAVICON_MISS_TTL_MS + 60_000) });
    expect(await fresh.svc.get(target)).toBeNull();
    expect(fresh.find).not.toHaveBeenCalled();
    const stale = make({ domain: "shop.example.com", mime: null, data: null, fetchedAt: new Date(NOW - FAVICON_MISS_TTL_MS - 1000) });
    await stale.svc.get(target);
    expect(stale.find).toHaveBeenCalledTimes(1);
  });

  it("caches a miss", async () => {
    const { svc, upsert } = make(null, jest.fn().mockResolvedValue(null));
    expect(await svc.get(target)).toBeNull();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ data: null, mime: null }) }));
  });

  it("does nothing for an app without a usable domain", async () => {
    const { svc, find } = make(null);
    expect(await svc.get({ id: "a1", domain: null, extraDomains: [] })).toBeNull();
    expect(await svc.get({ id: "a1", domain: "10.0.0.1", extraDomains: [] })).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it("shares one fetch between concurrent requests for the same app", async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = jest.fn().mockImplementation(() => new Promise((r) => { release = r; }));
    const { svc } = make(null, slow);
    const a = svc.get(target);
    const b = svc.get(target);
    await new Promise((r) => setImmediate(r));
    release({ mime: "image/png", data: PNG });
    await Promise.all([a, b]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("returns null when the cache write fails", async () => {
    const { svc, upsert } = make(null);
    upsert.mockRejectedValue(new Error("db down"));
    expect(await svc.get(target)).toBeNull();
  });
});
