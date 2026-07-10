import { describe, it, expect, afterEach, vi } from "vitest";
import { apiFetch } from "./api";

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
    // Same-origin proxy path.
    expect(calls[0].url).toBe("/api/servers");
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
