/* Tugra service worker.
 *
 * Deliberately small and deliberately blind to data:
 *  - offline shell only: it keeps ONE static page (/offline) so a dropped connection shows a calm message instead of the
 *    browser's error page. It never caches API responses, pages, scripts or anything else, and it never touches a
 *    request that is not a top-level navigation, so no private data can end up in a cache.
 *  - Web Push: shows the notification the hub sent and opens the panel when it is tapped.
 */
const SHELL_CACHE = "tugra-shell-v1";
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch(OFFLINE_URL, { cache: "reload", credentials: "omit" });
        // Never keep a redirect (an auth bounce) or an error page as the offline shell.
        if (res.ok && !res.redirected) await (await caches.open(SHELL_CACHE)).put(OFFLINE_URL, res);
      } catch {
        /* installing while offline: the worker still works, it just has no offline page yet */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only a top-level page load that fails to reach the network falls back to the offline page.
  if (req.mode !== "navigate" || req.method !== "GET") return;
  event.respondWith(
    fetch(req).catch(async () => {
      const cached = await (await caches.open(SHELL_CACHE)).match(OFFLINE_URL);
      return cached ?? Response.error();
    }),
  );
});

/** A tap target must stay on the panel's own origin, whatever the payload says. */
function safeTarget(raw) {
  try {
    const u = new URL(typeof raw === "string" && raw ? raw : "/", self.location.origin);
    return u.origin === self.location.origin ? u.href : self.location.origin + "/";
  } catch {
    return self.location.origin + "/";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Tugra";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" && data.tag ? data.tag : undefined,
    icon: "/pwa/icon-192.png",
    badge: "/pwa/icon-192.png",
    data: { url: safeTarget(data.url) },
    // A failure should stay on screen until someone looks at it.
    requireInteraction: data.level === "failure",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeTarget(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
