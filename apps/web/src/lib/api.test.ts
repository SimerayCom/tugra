import { describe, it, expect, afterEach, vi } from "vitest";
import { apiFetch, api } from "./api";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiFetch 401 → cookie refresh → retry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes on 401 (cookie-based) and retries the request, always with credentials", async () => {
    const calls: { url: string; auth: string | null; credentials?: RequestCredentials }[] = [];
    let serverHits = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        credentials: init?.credentials,
      });
      if (String(url).endsWith("/auth/refresh")) return jsonRes(200, { accessToken: "a", refreshToken: "b" });
      serverHits += 1;
      return serverHits === 1 ? jsonRes(401, { message: "expired" }) : jsonRes(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await apiFetch<{ ok: boolean }>("/servers");
    expect(out.ok).toBe(true);
    // No Authorization header is ever sent — auth is the cookie.
    expect(calls.every((c) => c.auth === null)).toBe(true);
    // Every request opts into credentials so the cookie rides along.
    expect(calls.every((c) => c.credentials === "include")).toBe(true);
    // Exactly one refresh, and /servers is called twice (401 then retry).
    expect(calls.filter((c) => c.url.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/servers"))).toHaveLength(2);
    // Same-origin proxy path, under the versioned /api/v1 base.
    expect(calls[0].url).toBe("/api/v1/servers");
  });

  it("sends the X-CSRF-Token header (from the tg_csrf cookie) on mutations", async () => {
    document.cookie = "tg_csrf=csrf-abc";
    let csrf: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        csrf = new Headers(init?.headers).get("x-csrf-token");
        return jsonRes(200, { ok: true });
      }),
    );
    await apiFetch("/apps/x/stop", { method: "POST" }, false);
    expect(csrf).toBe("csrf-abc");
  });

  it("throws ApiError on non-ok without refresh", async () => {
    const fetchMock = vi.fn(async () => jsonRes(409, { message: "conflict" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiFetch("/x", {}, false)).rejects.toThrow(/conflict/);
  });
});

describe("api.listChannelEvents (single-source event list)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs the canonical event list from /channels/events", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(String(url));
      return jsonRes(200, { events: ["deploy_failed", "backup_failed"] });
    }));
    const out = await api.listChannelEvents();
    expect(out.events).toContain("backup_failed");
    expect(seen[0]).toBe("/api/v1/channels/events");
  });
});

describe("api.getInstanceStatus (public onboarding status)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /instance/status and does NOT retry/refresh on 401", async () => {
    const seen: string[] = [];
    let hits = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(String(url));
      hits += 1;
      // If a refresh were attempted this endpoint would be hit twice; assert it's not.
      return jsonRes(200, { initialized: false, allowRegistration: true, edition: "community", ssoEnabled: false });
    }));
    const out = await api.getInstanceStatus();
    expect(out).toEqual({ initialized: false, allowRegistration: true, edition: "community", ssoEnabled: false });
    expect(seen[0]).toBe("/api/v1/instance/status");
    expect(hits).toBe(1);
    expect(seen.some((u) => u.endsWith("/auth/refresh"))).toBe(false);
  });
});

describe("api instance settings (owner)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET /instance/settings and PATCH with the patch body", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body as string | undefined });
      return jsonRes(200, { apiEnabled: true, apiAllowedIps: ["10.0.0.0/8"] });
    }));
    await api.getInstanceSettings();
    await api.updateInstanceSettings({ apiEnabled: false, apiAllowedIps: ["1.2.3.4"] });
    expect(calls[0]).toMatchObject({ url: "/api/v1/instance/settings" });
    expect(calls[1]).toMatchObject({ url: "/api/v1/instance/settings", method: "PATCH" });
    expect(JSON.parse(calls[1].body!)).toEqual({ apiEnabled: false, apiAllowedIps: ["1.2.3.4"] });
  });
});
