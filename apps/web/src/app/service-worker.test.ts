import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import manifest from "./manifest";

const SW = readFileSync(resolve(__dirname, "../../public/sw.js"), "utf8");
const ORIGIN = "https://panel.example.com";

type Handler = (e: Record<string, unknown>) => void;

/** Run the real sw.js in a sandbox with a fake service-worker global and return what it registered. */
function boot(opts: { fetch?: (req: unknown) => Promise<unknown> } = {}) {
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, unknown>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const focused: Array<{ url: string; navigated?: string }> = [];
  let windows: Array<{ url: string; focus: () => Promise<void>; navigate: (u: string) => Promise<void> }> = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (t: string, h: Handler) => { handlers[t] = h; },
    skipWaiting: vi.fn(async () => {}),
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: async () => windows,
      openWindow: async (u: string) => { opened.push(u); },
    },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
  };
  const caches = {
    open: async () => ({ put: async (k: string, v: unknown) => { store.set(k, v); }, match: async (k: string) => store.get(k) }),
    keys: async () => ["tugra-shell-v1", "old-cache"],
    delete: vi.fn(async () => true),
  };
  const ctx = vm.createContext({
    self,
    caches,
    fetch: opts.fetch ?? (async () => ({ ok: true, redirected: false })),
    URL,
    Response: { error: () => "network-error" },
    Promise,
  });
  vm.runInContext(SW, ctx);
  return {
    handlers, store, shown, opened, caches, self,
    setWindows: (w: string[]) => {
      windows = w.map((url) => ({ url, focus: async () => { focused.push({ url }); }, navigate: async (u: string) => { focused.push({ url, navigated: u }); } }));
    },
    focused,
  };
}

async function dispatch(h: Handler, extra: Record<string, unknown> = {}) {
  const waits: Promise<unknown>[] = [];
  let responded: Promise<unknown> | undefined;
  h({ waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<unknown>) => { responded = p; }, ...extra });
  await Promise.all(waits);
  return responded;
}

describe("sw.js: offline shell only", () => {
  it("keeps the offline page (and only that) at install, and drops other caches at activate", async () => {
    const sw = boot();
    await dispatch(sw.handlers.install);
    expect([...sw.store.keys()]).toEqual(["/offline"]);
    await dispatch(sw.handlers.activate);
    expect(sw.caches.delete).toHaveBeenCalledWith("old-cache");
    expect(sw.caches.delete).not.toHaveBeenCalledWith("tugra-shell-v1");
  });

  it("does not keep a redirected or failed offline fetch", async () => {
    const sw = boot({ fetch: async () => ({ ok: true, redirected: true }) });
    await dispatch(sw.handlers.install);
    expect(sw.store.size).toBe(0);
  });

  it("answers a failed navigation with the offline page", async () => {
    const sw = boot({ fetch: async () => { throw new TypeError("offline"); } });
    sw.store.set("/offline", "OFFLINE-PAGE");
    const out = await dispatch(sw.handlers.fetch, { request: { mode: "navigate", method: "GET" } });
    expect(out).toBe("OFFLINE-PAGE");
  });

  it("never intercepts API calls or any other non-navigation request", async () => {
    const sw = boot();
    const respond = vi.fn();
    sw.handlers.fetch({ request: { mode: "cors", method: "GET", url: `${ORIGIN}/api/v1/apps` }, respondWith: respond });
    sw.handlers.fetch({ request: { mode: "same-origin", method: "POST", url: `${ORIGIN}/api/v1/apps` }, respondWith: respond });
    sw.handlers.fetch({ request: { mode: "navigate", method: "POST" }, respondWith: respond });
    expect(respond).not.toHaveBeenCalled();
  });

  it("has no code path that stores API data", () => {
    expect(SW).not.toMatch(/\/api\b/);
    expect((SW.match(/\.put\(/g) ?? []).length).toBe(1); // the single offline-shell put
  });
});

describe("sw.js: push", () => {
  it("shows the payload, keeps failures on screen, and points taps at the panel", async () => {
    const sw = boot();
    await dispatch(sw.handlers.push, { data: { json: () => ({ title: "Server offline", body: "web-1", tag: "server_offline", level: "failure", url: `${ORIGIN}/servers/s1` }) } });
    expect(sw.shown[0].title).toBe("Server offline");
    expect(sw.shown[0].options).toMatchObject({ body: "web-1", tag: "server_offline", requireInteraction: true, data: { url: `${ORIGIN}/servers/s1` } });
  });

  it("survives an empty or malformed payload", async () => {
    const sw = boot();
    await dispatch(sw.handlers.push, { data: { json: () => { throw new Error("bad"); } } });
    await dispatch(sw.handlers.push, {});
    expect(sw.shown.map((s) => s.title)).toEqual(["Tugra", "Tugra"]);
  });

  it("opens the panel on tap, never an off-origin URL", async () => {
    const sw = boot();
    const close = vi.fn();
    await dispatch(sw.handlers.notificationclick, { notification: { close, data: { url: "https://evil.example.org/phish" } } });
    expect(close).toHaveBeenCalled();
    expect(sw.opened).toEqual([`${ORIGIN}/`]);
    await dispatch(sw.handlers.notificationclick, { notification: { close, data: { url: `${ORIGIN}/apps/a1` } } });
    expect(sw.opened[1]).toBe(`${ORIGIN}/apps/a1`);
  });

  it("focuses and navigates an open panel window instead of opening another", async () => {
    const sw = boot();
    sw.setWindows([`${ORIGIN}/dashboard`]);
    await dispatch(sw.handlers.notificationclick, { notification: { close: vi.fn(), data: { url: `${ORIGIN}/apps/a1` } } });
    expect(sw.opened).toEqual([]);
    expect(sw.focused).toEqual([{ url: `${ORIGIN}/dashboard` }, { url: `${ORIGIN}/dashboard`, navigated: `${ORIGIN}/apps/a1` }]);
  });
});

describe("web app manifest", () => {
  it("is installable: standalone, scoped, with 192/512 and a maskable icon that exist on disk", () => {
    const m = manifest();
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    const icons = m.icons ?? [];
    expect(icons.some((i) => i.sizes === "192x192")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const i of icons) expect(() => readFileSync(resolve(__dirname, "../../public", `.${i.src}`))).not.toThrow();
  });
});
